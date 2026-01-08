import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import ical from 'ical-generator';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Enable stealth mode to bypass bot detection
puppeteerExtra.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || './data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Config management
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Session management
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  return token;
}

function validateSession(token) {
  const time = sessions.get(token);
  if (!time) return false;
  if (Date.now() - time > 86400000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookies(header) {
  const cookies = {};
  if (header) {
    header.split(';').forEach(c => {
      const [name, value] = c.trim().split('=');
      if (name && value) cookies[name] = value;
    });
  }
  return cookies;
}

// Cache
let cachedICS = null;
let cacheTime = 0;
const CACHE_TTL = 15 * 60 * 1000;

// ==================== ROUTES ====================

// Admin panel
app.get('/admin', (req, res) => {
  const config = loadConfig();
  const cookies = parseCookies(req.headers.cookie);
  const isLoggedIn = cookies.session && validateSession(cookies.session);
  
  if (!config.adminPassword) {
    return res.send(setupPage());
  }
  
  if (!isLoggedIn) {
    return res.send(loginPage());
  }
  
  res.send(adminPage(config, req));
});

app.post('/admin', (req, res) => {
  const config = loadConfig();
  const cookies = parseCookies(req.headers.cookie);
  const isLoggedIn = cookies.session && validateSession(cookies.session);
  
  if (req.body.action === 'setup') {
    const newConfig = {
      adminPassword: req.body.adminPassword,
      appointyEmail: req.body.appointyEmail,
      appointyPassword: req.body.appointyPassword,
      appointyBookingUrl: req.body.appointyBookingUrl || 'https://mathnasium-booking.appointy.com/portlandme/my-bookings',
      calendarToken: crypto.randomBytes(24).toString('hex'),
      calendarName: req.body.calendarName || 'Mathnasium Appointments'
    };
    saveConfig(newConfig);
    const token = createSession();
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; Max-Age=86400`);
    return res.redirect('/admin');
  }
  
  if (req.body.action === 'login') {
    if (req.body.password === config.adminPassword) {
      const token = createSession();
      res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; Max-Age=86400`);
      return res.redirect('/admin');
    }
    return res.send(loginPage('Invalid password'));
  }
  
  if (req.body.action === 'logout') {
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
    return res.redirect('/admin');
  }
  
  if (req.body.action === 'save' && isLoggedIn) {
    config.appointyEmail = req.body.appointyEmail;
    config.appointyPassword = req.body.appointyPassword;
    config.appointyBookingUrl = req.body.appointyBookingUrl;
    config.calendarName = req.body.calendarName;
    if (req.body.calendarToken) config.calendarToken = req.body.calendarToken;
    if (req.body.adminPassword) config.adminPassword = req.body.adminPassword;
    saveConfig(config);
    return res.redirect('/admin?saved=1');
  }
  
  res.redirect('/admin');
});

// Calendar endpoint
app.get('/calendar/:token', async (req, res) => {
  const config = loadConfig();
  
  if (!config.calendarToken || req.params.token !== config.calendarToken) {
    return res.status(403).send('Invalid token');
  }
  
  const now = Date.now();
  const forceRefresh = req.query.refresh === 'true';
  
  if (!forceRefresh && cachedICS && (now - cacheTime) < CACHE_TTL) {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('X-Cache', 'HIT');
    return res.send(cachedICS);
  }
  
  try {
    console.log('Fetching appointments with Puppeteer...');
    const appointments = await scrapeAppointments(config);
    cachedICS = generateICS(appointments, config.calendarName);
    cacheTime = now;
    
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('X-Cache', 'MISS');
    res.send(cachedICS);
  } catch (error) {
    console.error('Error:', error.message);
    if (cachedICS) {
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('X-Cache', 'STALE');
      return res.send(cachedICS);
    }
    res.status(500).send('Error fetching appointments: ' + error.message);
  }
});

// Health check
app.get('/health', async (req, res) => {
  const config = loadConfig();
  res.json({
    status: 'ok',
    method: 'puppeteer',
    configured: !!config.appointyEmail
  });
});

// Root redirect
app.get('/', (req, res) => res.redirect('/admin'));

// ==================== SCRAPING WITH PUPPETEER ====================

async function scrapeAppointments(config) {
  console.log('Launching browser...');
  
  const browser = await puppeteerExtra.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  });
  
  const page = await browser.newPage();
  
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });
  
  try {
    console.log('Navigating to:', config.appointyBookingUrl);
    await page.goto(config.appointyBookingUrl, { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    
    // Wait for page to render (SPA)
    await page.waitForFunction(() => {
      return !document.querySelector('.loader-container') && 
             !document.querySelector('.spinner');
    }, { timeout: 30000 }).catch(() => {
      console.log('Loader may still be present, continuing...');
    });
    
    // Check if we need to login
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);
    
    if (currentUrl.includes('login') || currentUrl.includes('sign-in')) {
      console.log('Login required...');
      await performLogin(page, config);
    }
    
    // Navigate to my-bookings if needed
    if (!page.url().includes('my-bookings')) {
      console.log('Navigating to bookings page...');
      await page.goto(config.appointyBookingUrl, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
    }
    
    // Wait for bookings to load
    console.log('Waiting for bookings to load...');
    await new Promise(r => setTimeout(r, 5000));
    
    // Try to wait for booking elements
    await page.waitForSelector('[class*="booking"], [class*="appointment"], .card, article, tr, [class*="MuiCard"], [class*="session"]', { 
      timeout: 15000 
    }).catch(() => {
      console.log('No booking selectors found, will try text extraction...');
    });
    
    // Scroll to load all appointments (lazy loading with delay)
    console.log('Scrolling to load all appointments...');
    
    // First check for "Load More" or similar buttons
    const hasLoadMore = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
      return buttons.some(b => /load\s*more|show\s*more|view\s*all|see\s*all/i.test(b.innerText));
    });
    console.log('Has Load More button:', hasLoadMore);
    
    // Get the scrollable element - likely a MUI component
    const scrollInfo = await page.evaluate(() => {
      // Look for the actual list container
      const listElements = document.querySelectorAll('[class*="MuiList"], [class*="list"], [class*="scroll"], [role="list"]');
      const info = [];
      listElements.forEach(el => {
        info.push({
          tag: el.tagName,
          class: el.className.substring(0, 100),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollable: el.scrollHeight > el.clientHeight
        });
      });
      return info;
    });
    console.log('Scrollable elements found:', JSON.stringify(scrollInfo).substring(0, 500));
    
    let previousCount = 0;
    let noChangeCount = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 50;
    
    while (scrollAttempts < maxScrollAttempts && noChangeCount < 5) {
      // Click "Load More" if it exists
      const clickedLoadMore = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const loadMore = buttons.find(b => /load\s*more|show\s*more|view\s*all|see\s*all/i.test(b.innerText));
        if (loadMore) {
          loadMore.click();
          return true;
        }
        return false;
      });
      
      if (clickedLoadMore) {
        console.log('Clicked Load More button');
        await new Promise(r => setTimeout(r, 3000));
      }
      
      // Scroll everything - window, body, and all scrollable containers
      await page.evaluate(() => {
        // Scroll window
        window.scrollTo(0, document.body.scrollHeight);
        document.documentElement.scrollTop = document.documentElement.scrollHeight;
        
        // Find and scroll all potentially scrollable elements
        const allElements = document.querySelectorAll('*');
        allElements.forEach(el => {
          const style = window.getComputedStyle(el);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            el.scrollTop = el.scrollHeight;
          }
        });
      });
      
      // Wait for content
      await new Promise(r => setTimeout(r, 3500));
      
      // Count appointments by date pattern
      const currentCount = await page.evaluate(() => {
        const text = document.body.innerText;
        const matches = text.match(/\w{3}\s*\|\s*\w{3}\s+\d{1,2},\s*\d{2}/g);
        return matches ? matches.length : 0;
      });
      
      if (currentCount === previousCount) {
        noChangeCount++;
        console.log('No new appointments after scroll', scrollAttempts, '(count:', currentCount, ')');
      } else {
        noChangeCount = 0;
        console.log('Appointments:', previousCount, '->', currentCount);
      }
      
      previousCount = currentCount;
      scrollAttempts++;
      
      // Also try pressing End key and Page Down
      await page.keyboard.press('End');
      await new Promise(r => setTimeout(r, 500));
      await page.keyboard.press('PageDown');
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log('Finished scrolling, found', previousCount, 'appointment dates');
    
    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 1000));
    
    // Debug: Log page content
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('Page text length:', pageText.length, 'chars');
    
    // Extract appointments
    const appointments = await extractAppointments(page);
    console.log(`Found ${appointments.length} appointments`);
    
    return appointments;
    
  } finally {
    await browser.close();
  }
}

async function performLogin(page, config) {
  console.log('Performing login...');
  
  // Wait for React/Vue to render - wait for any input to appear
  console.log('Waiting for login form to render...');
  await page.waitForSelector('input, [contenteditable="true"]', { 
    visible: true, 
    timeout: 30000 
  }).catch(() => console.log('Timeout waiting for input'));
  
  // Extra wait for SPA to fully render
  await new Promise(r => setTimeout(r, 5000));
  
  // Debug page content
  const pageContent = await page.content();
  console.log('Page has', pageContent.length, 'chars');
  
  // Find any visible input fields
  const allInputs = await page.$$eval('input', inputs => 
    inputs.map(i => ({
      type: i.type,
      name: i.name,
      id: i.id,
      placeholder: i.placeholder,
      className: i.className,
      visible: i.offsetParent !== null
    }))
  ).catch(() => []);
  console.log('Found inputs:', JSON.stringify(allInputs));
  
  // Extended email selectors for various OAuth/OIDC providers
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="identifier"]',
    'input[name="username"]',
    'input[name="login"]',
    'input[name="user"]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[id*="login" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="user" i]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[type="text"]' // Last resort - first text input
  ];
  
  let emailFilled = false;
  for (const selector of emailSelectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        const isVisible = await el.isIntersectingViewport();
        if (isVisible) {
          await el.click({ clickCount: 3 });
          await el.type(config.appointyEmail, { delay: 30 });
          emailFilled = true;
          console.log('Filled email with selector:', selector);
          break;
        }
      }
    } catch {}
  }
  
  if (!emailFilled) {
    // Try clicking any visible input
    try {
      await page.click('input:not([type="hidden"]):not([type="password"])');
      await page.keyboard.type(config.appointyEmail, { delay: 30 });
      emailFilled = true;
      console.log('Filled email via keyboard');
    } catch (e) {
      console.log('Could not fill email:', e.message);
    }
  }
  
  // Find and fill password field
  const passwordEl = await page.$('input[type="password"]');
  if (passwordEl) {
    await passwordEl.click({ clickCount: 3 });
    await passwordEl.type(config.appointyPassword, { delay: 30 });
    console.log('Filled password');
  }
  
  // Click submit button with extended selectors
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[class*="submit" i]',
    'button[class*="login" i]',
    'button[class*="sign" i]',
    'button[class*="btn" i]',
    '[role="button"]',
    'button'
  ];
  
  let clicked = false;
  for (const selector of submitSelectors) {
    try {
      const btns = await page.$$(selector);
      for (const btn of btns) {
        const isVisible = await btn.isIntersectingViewport().catch(() => false);
        const text = await btn.evaluate(el => el.innerText || el.value || '').catch(() => '');
        if (isVisible && text.toLowerCase().match(/sign|log|continu|submit|next/i)) {
          await btn.click();
          clicked = true;
          console.log('Clicked button:', text);
          break;
        }
      }
      if (clicked) break;
    } catch {}
  }
  
  if (!clicked) {
    // Just click the first visible button
    try {
      await page.click('button');
      console.log('Clicked first button');
    } catch {}
  }
  
  // Wait for navigation or network
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    new Promise(r => setTimeout(r, 20000))
  ]).catch(() => {});
  
  console.log('After first submit, URL:', page.url());
  
  // Check if we need to enter password on second page
  await new Promise(r => setTimeout(r, 2000));
  const passwordVisible = await page.$('input[type="password"]');
  if (passwordVisible) {
    const isReallyVisible = await passwordVisible.isIntersectingViewport().catch(() => false);
    if (isReallyVisible) {
      console.log('Password field on second page...');
      await passwordVisible.click({ clickCount: 3 });
      await passwordVisible.type(config.appointyPassword, { delay: 30 });
      
      // Click submit again
      for (const selector of submitSelectors) {
        try {
          const btns = await page.$$(selector);
          for (const btn of btns) {
            const isVisible = await btn.isIntersectingViewport().catch(() => false);
            if (isVisible) {
              await btn.click();
              break;
            }
          }
        } catch {}
      }
      
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
        new Promise(r => setTimeout(r, 20000))
      ]).catch(() => {});
    }
  }
  
  console.log('Login completed, current URL:', page.url());
}

async function extractAppointments(page) {
  return await page.evaluate(() => {
    const results = [];
    const bodyText = document.body.innerText;
    
    // Pattern for Appointy format: "Thu | Jan 08, 26" followed by "4:00pm"
    // Also handles: "Mon | Jan 12, 26" etc.
    const appointyPattern = /(\w{3})\s*\|\s*(\w{3})\s+(\d{1,2}),\s*(\d{2})\s*\n?\s*Scheduled\s*\n?\s*(\d{1,2}):(\d{2})(am|pm)/gi;
    
    let match;
    while ((match = appointyPattern.exec(bodyText)) !== null) {
      const [, dayName, month, day, year, hour, minute, ampm] = match;
      results.push({
        title: 'Mathnasium Session',
        dayName,
        month,
        day,
        year: '20' + year,
        hour,
        minute,
        ampm,
        rawText: match[0]
      });
    }
    
    // If that didn't work, try simpler pattern
    if (results.length === 0) {
      // Look for "Jan 08, 26" or "Jan 12, 26" patterns
      const datePattern = /(\w{3})\s+(\d{1,2}),\s*(\d{2,4})/g;
      const timePattern = /(\d{1,2}):(\d{2})\s*(am|pm)/i;
      
      let dateMatch;
      while ((dateMatch = datePattern.exec(bodyText)) !== null) {
        const nearbyText = bodyText.substring(dateMatch.index, dateMatch.index + 200);
        const timeMatch = timePattern.exec(nearbyText);
        
        if (timeMatch) {
          let year = dateMatch[3];
          if (year.length === 2) year = '20' + year;
          
          results.push({
            title: 'Mathnasium Session',
            month: dateMatch[1],
            day: dateMatch[2],
            year,
            hour: timeMatch[1],
            minute: timeMatch[2],
            ampm: timeMatch[3],
            rawText: nearbyText.substring(0, 100)
          });
        }
      }
    }
    
    console.log('Extracted', results.length, 'raw appointments');
    return results;
  });
}

function parseAppointmentData(raw) {
  try {
    // Parse the new format: { month: 'Jan', day: '08', year: '2026', hour: '4', minute: '00', ampm: 'pm' }
    const monthMap = {
      'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
      'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
    };
    
    const monthIndex = monthMap[raw.month?.toLowerCase()];
    if (monthIndex === undefined) {
      console.log('Unknown month:', raw.month);
      return null;
    }
    
    const year = parseInt(raw.year);
    const day = parseInt(raw.day);
    let hour = parseInt(raw.hour);
    const minute = parseInt(raw.minute);
    const ampm = raw.ampm?.toLowerCase();
    
    // Convert to 24-hour format
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    
    const start = new Date(year, monthIndex, day, hour, minute, 0, 0);
    
    // Default session length is 60 minutes based on the page content
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    
    console.log('Parsed appointment:', start.toISOString(), '-', end.toISOString());
    
    return {
      title: raw.title || 'Mathnasium Session',
      start,
      end
    };
  } catch (e) {
    console.log('Parse error:', e.message);
    return null;
  }
}

function generateICS(rawAppointments, calendarName) {
  const calendar = ical({
    name: calendarName,
    timezone: 'America/New_York',
    ttl: 60 * 60
  });
  
  for (const raw of rawAppointments) {
    const apt = parseAppointmentData(raw);
    if (!apt) continue;
    
    const uid = crypto.createHash('md5')
      .update(`${apt.start.toISOString()}-${apt.end.toISOString()}`)
      .digest('hex') + '@appointy';
    
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

// ==================== HTML PAGES ====================

function setupPage() {
  return `<!DOCTYPE html>
<html><head><title>Setup</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui; background: #0a0a0f; color: #e4e4e7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 32px; max-width: 450px; width: 100%; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .sub { color: #71717a; margin-bottom: 24px; }
  label { display: block; font-size: 14px; color: #a1a1aa; margin-bottom: 6px; }
  input { width: 100%; padding: 12px; background: #09090b; border: 1px solid #27272a; border-radius: 8px; color: #fff; font-size: 14px; margin-bottom: 16px; }
  input:focus { outline: none; border-color: #3b82f6; }
  button { width: 100%; padding: 14px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); border: none; border-radius: 8px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
</style></head>
<body>
<div class="card">
  <h1>📅 Initial Setup</h1>
  <p class="sub">Configure your Appointy calendar sync</p>
  <form method="POST">
    <input type="hidden" name="action" value="setup">
    <label>Admin Password</label>
    <input type="password" name="adminPassword" required placeholder="Choose a password">
    <label>Appointy Email</label>
    <input type="email" name="appointyEmail" required placeholder="your-email@example.com">
    <label>Appointy Password</label>
    <input type="password" name="appointyPassword" required>
    <label>Booking URL</label>
    <input type="text" name="appointyBookingUrl" value="https://mathnasium-booking.appointy.com/portlandme/my-bookings">
    <label>Calendar Name</label>
    <input type="text" name="calendarName" value="Mathnasium Appointments">
    <button type="submit">Complete Setup</button>
  </form>
</div>
</body></html>`;
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html><head><title>Login</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui; background: #0a0a0f; color: #e4e4e7; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 32px; max-width: 380px; width: 100%; text-align: center; }
  h1 { font-size: 24px; margin-bottom: 24px; }
  input { width: 100%; padding: 12px; background: #09090b; border: 1px solid #27272a; border-radius: 8px; color: #fff; font-size: 14px; margin-bottom: 16px; }
  button { width: 100%; padding: 14px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); border: none; border-radius: 8px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
  .error { background: rgba(239,68,68,0.1); color: #ef4444; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
</style></head>
<body>
<div class="card">
  <h1>🔐 Login</h1>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST">
    <input type="hidden" name="action" value="login">
    <input type="password" name="password" placeholder="Admin Password" required autofocus>
    <button type="submit">Login</button>
  </form>
</div>
</body></html>`;
}

function adminPage(config, req) {
  const host = req.headers.host || 'localhost:3000';
  const calendarUrl = `http://${host}/calendar/${config.calendarToken}`;
  const saved = req.query?.saved === '1';
  
  return `<!DOCTYPE html>
<html><head><title>Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui; background: #0a0a0f; color: #e4e4e7; min-height: 100vh; padding: 20px; }
  .container { max-width: 600px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 24px; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .url-box { background: #09090b; padding: 14px; border-radius: 8px; font-family: monospace; font-size: 13px; color: #22c55e; word-break: break-all; margin-bottom: 12px; }
  .copy-btn { background: #27272a; border: none; color: #fff; padding: 10px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  label { display: block; font-size: 13px; color: #a1a1aa; margin-bottom: 6px; }
  input { width: 100%; padding: 10px; background: #09090b; border: 1px solid #27272a; border-radius: 6px; color: #fff; font-size: 14px; margin-bottom: 12px; }
  button { padding: 12px 20px; background: #22c55e; border: none; border-radius: 8px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
  .logout { background: transparent; border: 1px solid #27272a; color: #71717a; padding: 8px 16px; float: right; width: auto; }
  .success { background: rgba(34,197,94,0.1); color: #22c55e; padding: 12px; border-radius: 8px; margin-bottom: 16px; }
  .instructions { background: #09090b; padding: 14px; border-radius: 8px; margin-top: 12px; font-size: 13px; color: #a1a1aa; }
  .instructions ol { padding-left: 18px; }
  .instructions li { margin: 6px 0; }
</style></head>
<body>
<div class="container">
  <form method="POST" style="float:right"><input type="hidden" name="action" value="logout"><button type="submit" class="logout">Logout</button></form>
  <h1>📅 Calendar Sync</h1>
  
  ${saved ? '<div class="success">✓ Saved!</div>' : ''}
  
  <div class="card">
    <div class="card-title">🔗 Your Calendar URL</div>
    <div class="url-box" id="url">${calendarUrl}</div>
    <button type="button" class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('url').textContent).then(()=>this.textContent='✓ Copied!')">📋 Copy URL</button>
    <div class="instructions">
      <strong>Subscribe in Apple Calendar:</strong>
      <ol>
        <li>Open Calendar app</li>
        <li>File → New Calendar Subscription</li>
        <li>Paste the URL above</li>
        <li>Set refresh to "Every hour"</li>
      </ol>
    </div>
  </div>
  
  <div class="card">
    <div class="card-title">⚙️ Settings</div>
    <form method="POST">
      <input type="hidden" name="action" value="save">
      <label>Appointy Email</label>
      <input type="email" name="appointyEmail" value="${config.appointyEmail || ''}">
      <label>Appointy Password</label>
      <input type="password" name="appointyPassword" value="${config.appointyPassword || ''}">
      <label>Booking URL</label>
      <input type="text" name="appointyBookingUrl" value="${config.appointyBookingUrl || ''}">
      <label>Calendar Name</label>
      <input type="text" name="calendarName" value="${config.calendarName || ''}">
      <button type="submit">Save</button>
    </form>
  </div>
</div>
</body></html>`;
}

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  Appointy Calendar Sync (Puppeteer)              ║
║  Running on http://0.0.0.0:${PORT}                   ║
║  Admin: http://localhost:${PORT}/admin               ║
╚══════════════════════════════════════════════════╝
  `);
});
