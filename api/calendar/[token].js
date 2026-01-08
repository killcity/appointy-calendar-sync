import crypto from 'crypto';
import ical from 'ical-generator';

// In-memory cache
let cachedICS = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Redis helper
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  
  const res = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return data.result;
}

async function getConfig() {
  const stored = await redisGet('appointy:config');
  if (stored) {
    try { return JSON.parse(stored); } catch {}
  }
  return {
    appointyEmail: process.env.APPOINTY_EMAIL,
    appointyPassword: process.env.APPOINTY_PASSWORD,
    appointyBookingUrl: process.env.APPOINTY_BOOKING_URL || 'https://mathnasium-booking.appointy.com/portlandme/my-bookings',
    flaresolverrUrl: process.env.FLARESOLVERR_URL,
    calendarToken: process.env.CALENDAR_TOKEN,
    calendarName: process.env.CALENDAR_NAME || 'Mathnasium Appointments',
  };
}

export default async function handler(req, res) {
  const config = await getConfig();
  const { token } = req.query;
  
  if (!config.calendarToken) {
    return res.status(500).json({ error: 'Not configured. Visit /api/admin' });
  }
  
  // Constant-time comparison
  const expected = Buffer.from(config.calendarToken);
  const provided = Buffer.from(String(token || ''));
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  
  // Check cache
  const now = Date.now();
  const forceRefresh = req.query.refresh === 'true';
  
  if (!forceRefresh && cachedICS && (now - cacheTime) < CACHE_TTL) {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cachedICS);
  }
  
  try {
    if (!config.flaresolverrUrl) {
      throw new Error('FlareSolverr URL not configured. Visit /api/admin');
    }
    if (!config.appointyEmail || !config.appointyPassword) {
      throw new Error('Appointy credentials not configured');
    }
    
    console.log('Fetching appointments via FlareSolverr...');
    const appointments = await scrapeWithFlaresolverr(config);
    const icsContent = generateICS(appointments, config.calendarName);
    
    cachedICS = icsContent;
    cacheTime = now;
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('X-Cache', 'MISS');
    return res.send(icsContent);
    
  } catch (error) {
    console.error('Error:', error.message);
    if (cachedICS) {
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('X-Cache', 'STALE');
      return res.send(cachedICS);
    }
    return res.status(500).json({ error: error.message });
  }
}

async function scrapeWithFlaresolverr(config) {
  const flare = config.flaresolverrUrl;
  
  // Step 1: Get initial page (will hit login)
  console.log('Step 1: Getting initial page...');
  const initialRes = await fetch(`${flare}/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'request.get',
      url: config.appointyBookingUrl,
      maxTimeout: 60000
    })
  });
  
  const initial = await initialRes.json();
  if (initial.status !== 'ok') {
    throw new Error(`FlareSolverr error: ${initial.message}`);
  }
  
  let cookies = initial.solution.cookies;
  let html = initial.solution.response;
  let currentUrl = initial.solution.url;
  
  console.log('Current URL:', currentUrl);
  
  // Check if we need to login
  if (currentUrl.includes('login') || currentUrl.includes('sign-in') || html.includes('type="password"')) {
    console.log('Step 2: Need to login...');
    
    // Find the login form action URL
    const formMatch = html.match(/<form[^>]*action=["']([^"']+)["']/i);
    let loginUrl = formMatch ? formMatch[1] : currentUrl;
    
    // Make login URL absolute
    if (loginUrl.startsWith('/')) {
      const urlObj = new URL(currentUrl);
      loginUrl = `${urlObj.origin}${loginUrl}`;
    }
    
    // Extract any hidden fields
    const hiddenFields = {};
    const hiddenMatches = html.matchAll(/<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi);
    for (const m of hiddenMatches) {
      hiddenFields[m[1]] = m[2];
    }
    
    // Try POST login
    const loginData = {
      ...hiddenFields,
      email: config.appointyEmail,
      password: config.appointyPassword,
      username: config.appointyEmail, // Some forms use username
    };
    
    const loginRes = await fetch(`${flare}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.post',
        url: loginUrl,
        postData: new URLSearchParams(loginData).toString(),
        cookies: cookies,
        maxTimeout: 60000
      })
    });
    
    const loginResult = await loginRes.json();
    if (loginResult.status === 'ok') {
      cookies = loginResult.solution.cookies;
      html = loginResult.solution.response;
      currentUrl = loginResult.solution.url;
      console.log('After login URL:', currentUrl);
    }
  }
  
  // Step 3: Navigate to bookings page if needed
  if (!currentUrl.includes('my-bookings')) {
    console.log('Step 3: Navigating to bookings page...');
    const bookingsRes = await fetch(`${flare}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: config.appointyBookingUrl,
        cookies: cookies,
        maxTimeout: 60000
      })
    });
    
    const bookingsResult = await bookingsRes.json();
    if (bookingsResult.status === 'ok') {
      html = bookingsResult.solution.response;
      currentUrl = bookingsResult.solution.url;
    }
  }
  
  console.log('Final URL:', currentUrl);
  
  // Extract appointments from HTML
  return extractAppointmentsFromHTML(html);
}

function extractAppointmentsFromHTML(html) {
  const appointments = [];
  
  // Look for date patterns
  const datePatterns = [
    /(\w+day),?\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})/gi,  // "Monday, January 15, 2026"
    /(\w+)\s+(\d{1,2}),?\s+(\d{4})/gi,                // "January 15, 2026"
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g                // "1/15/2026"
  ];
  
  const timePattern = /(\d{1,2}):(\d{2})\s*(AM|PM)?(?:\s*[-–to]+\s*(\d{1,2}):(\d{2})\s*(AM|PM)?)?/gi;
  
  // Try to find booking cards/sections
  const cardPatterns = [
    /<div[^>]*class="[^"]*(?:booking|appointment|event|card|session)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<li[^>]*class="[^"]*(?:booking|appointment)[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  ];
  
  for (const pattern of cardPatterns) {
    const matches = html.matchAll(pattern);
    for (const match of matches) {
      const cardHtml = match[1] || match[0];
      const text = cardHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      
      // Find date
      let dateStr = null;
      for (const dp of datePatterns) {
        dp.lastIndex = 0;
        const dm = dp.exec(text);
        if (dm) {
          dateStr = dm[0];
          break;
        }
      }
      
      // Find time
      timePattern.lastIndex = 0;
      const tm = timePattern.exec(text);
      
      if (dateStr && tm) {
        const appointment = parseAppointment(dateStr, tm, text);
        if (appointment) {
          appointments.push(appointment);
        }
      }
    }
    
    if (appointments.length > 0) break;
  }
  
  // If no cards found, try to find dates/times in the whole page
  if (appointments.length === 0) {
    const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    
    for (const dp of datePatterns) {
      dp.lastIndex = 0;
      let dm;
      while ((dm = dp.exec(plainText)) !== null) {
        // Look for time near this date
        const nearbyText = plainText.substring(Math.max(0, dm.index - 100), dm.index + 200);
        timePattern.lastIndex = 0;
        const tm = timePattern.exec(nearbyText);
        
        if (tm) {
          const appointment = parseAppointment(dm[0], tm, nearbyText);
          if (appointment) {
            appointments.push(appointment);
          }
        }
      }
    }
  }
  
  console.log(`Found ${appointments.length} appointments`);
  return appointments;
}

function parseAppointment(dateStr, timeMatch, contextText) {
  try {
    // Parse date
    const cleaned = dateStr.replace(/,/g, '').trim();
    let date = new Date(cleaned);
    
    if (isNaN(date.getTime())) {
      const m = cleaned.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
      if (m) {
        let [, month, day, year] = m;
        if (year.length === 2) year = '20' + year;
        date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      }
    }
    
    if (isNaN(date.getTime())) return null;
    
    // Parse start time
    let startHour = parseInt(timeMatch[1]);
    const startMin = parseInt(timeMatch[2]);
    const startMer = timeMatch[3];
    
    if (startMer?.toUpperCase() === 'PM' && startHour !== 12) startHour += 12;
    if (startMer?.toUpperCase() === 'AM' && startHour === 12) startHour = 0;
    
    const start = new Date(date);
    start.setHours(startHour, startMin, 0, 0);
    
    // Parse end time
    let end;
    if (timeMatch[4]) {
      let endHour = parseInt(timeMatch[4]);
      const endMin = parseInt(timeMatch[5]);
      const endMer = timeMatch[6];
      
      if (endMer?.toUpperCase() === 'PM' && endHour !== 12) endHour += 12;
      if (endMer?.toUpperCase() === 'AM' && endHour === 12) endHour = 0;
      
      end = new Date(date);
      end.setHours(endHour, endMin, 0, 0);
    } else {
      end = new Date(start.getTime() + 60 * 60 * 1000); // Default 1 hour
    }
    
    // Try to extract title
    let title = 'Mathnasium Session';
    const titleMatch = contextText.match(/(?:session|class|lesson|tutoring)[:\s]+([^<\n]+)/i);
    if (titleMatch) {
      title = titleMatch[1].trim().substring(0, 50);
    }
    
    return { title, start, end };
  } catch {
    return null;
  }
}

function generateICS(appointments, calendarName) {
  const calendar = ical({
    name: calendarName,
    timezone: 'America/New_York',
    prodId: { company: 'appointy-sync', product: 'calendar', language: 'EN' },
    ttl: 60 * 60
  });
  
  for (const apt of appointments) {
    const uid = crypto.createHash('md5')
      .update(`${apt.title}-${apt.start.toISOString()}-${apt.end.toISOString()}`)
      .digest('hex') + '@appointy-sync';
    
    calendar.createEvent({
      uid,
      start: apt.start,
      end: apt.end,
      summary: apt.title,
      location: 'Mathnasium of Portland'
    }).createAlarm({ type: 'display', trigger: -60 * 60 });
  }
  
  return calendar.toString();
}

export const config = { maxDuration: 120 };
