import puppeteer from 'puppeteer-core';
import dotenv from 'dotenv';

dotenv.config();

const BOOKING_URL = process.env.APPOINTY_BOOKING_URL || 'https://mathnasium-booking.appointy.com/portlandme/my-bookings';
const EMAIL = process.env.APPOINTY_EMAIL;
const PASSWORD = process.env.APPOINTY_PASSWORD;

// Browserless.io config - get free API key at https://browserless.io
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const BROWSERLESS_URL = BROWSERLESS_TOKEN 
  ? `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`
  : null;

export async function scrapeAppointments(options = {}) {
  const { debug = false } = options;
  
  if (!EMAIL || !PASSWORD) {
    throw new Error('APPOINTY_EMAIL and APPOINTY_PASSWORD must be set in .env');
  }

  if (!BROWSERLESS_URL) {
    throw new Error('BROWSERLESS_TOKEN must be set. Get a free API key at https://browserless.io');
  }

  console.log('Connecting to Browserless.io...');
  
  const browser = await puppeteer.connect({
    browserWSEndpoint: BROWSERLESS_URL,
  });
  
  const page = await browser.newPage();
  
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  try {
    console.log('Navigating to booking page...');
    await page.goto(BOOKING_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Check if we need to log in
    const needsLogin = await page.evaluate(() => {
      const loginForm = document.querySelector('input[type="email"], input[type="password"], [class*="login"], [class*="signin"]');
      const loginButton = document.querySelector('button[type="submit"], [class*="login-btn"], [class*="sign-in"]');
      return !!(loginForm || loginButton);
    });

    if (needsLogin) {
      console.log('Login required, attempting authentication...');
      await performLogin(page);
    }

    // Wait for the bookings to load
    console.log('Waiting for bookings to load...');
    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
    
    // Give React/Vue/Angular apps time to render
    await new Promise(r => setTimeout(r, 2000));
    
    if (debug) {
      const screenshot = await page.screenshot({ fullPage: true, encoding: 'base64' });
      console.log('Screenshot (base64):', screenshot.substring(0, 100) + '...');
    }

    // Extract appointments
    const appointments = await extractAppointments(page);
    
    console.log(`Found ${appointments.length} appointment(s)`);
    
    if (debug) {
      console.log('Appointments:', JSON.stringify(appointments, null, 2));
    }
    
    return appointments;
    
  } catch (error) {
    console.error('Scraping failed:', error.message);
    if (debug) {
      const html = await page.content().catch(() => 'Could not get HTML');
      console.log('Page HTML snippet:', html.substring(0, 2000));
    }
    throw error;
  } finally {
    await page.close();
    await browser.disconnect();
  }
}

async function performLogin(page) {
  // Look for email input
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="Email" i]',
    '#email',
    '[data-testid="email-input"]'
  ];
  
  let emailInput = null;
  for (const selector of emailSelectors) {
    emailInput = await page.$(selector);
    if (emailInput) break;
  }
  
  if (!emailInput) {
    // Maybe there's a "Sign In" button we need to click first
    const signInButton = await page.$('text=Sign In') || 
                         await page.$('text=Log In') ||
                         await page.$('[class*="login"]') ||
                         await page.$('[class*="signin"]');
    if (signInButton) {
      await signInButton.click();
      await new Promise(r => setTimeout(r, 1000));
      
      for (const selector of emailSelectors) {
        emailInput = await page.$(selector);
        if (emailInput) break;
      }
    }
  }
  
  if (!emailInput) {
    throw new Error('Could not find email input field. The page structure may have changed.');
  }
  
  // Enter email
  await emailInput.type(EMAIL, { delay: 50 });
  
  // Look for password input
  const passwordSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    '#password'
  ];
  
  let passwordInput = null;
  for (const selector of passwordSelectors) {
    passwordInput = await page.$(selector);
    if (passwordInput) break;
  }
  
  if (passwordInput) {
    await passwordInput.type(PASSWORD, { delay: 50 });
  }
  
  // Look for and click submit button
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button:has-text("Continue")',
    '[class*="submit"]'
  ];
  
  for (const selector of submitSelectors) {
    const submitButton = await page.$(selector);
    if (submitButton) {
      await submitButton.click();
      break;
    }
  }
  
  // Wait for navigation after login
  await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
  
  // If password wasn't on same page, look for it now (2-step login)
  if (!passwordInput) {
    for (const selector of passwordSelectors) {
      passwordInput = await page.$(selector);
      if (passwordInput) {
        await passwordInput.type(PASSWORD, { delay: 50 });
        
        for (const submitSelector of submitSelectors) {
          const submitButton = await page.$(submitSelector);
          if (submitButton) {
            await submitButton.click();
            break;
          }
        }
        
        await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
        break;
      }
    }
  }
  
  // Verify login succeeded
  const stillOnLogin = await page.evaluate(() => {
    return !!document.querySelector('input[type="password"]:not([style*="display: none"])');
  });
  
  if (stillOnLogin) {
    throw new Error('Login appears to have failed. Check your credentials.');
  }
  
  console.log('Login successful!');
}

async function extractAppointments(page) {
  const appointments = await page.evaluate(() => {
    const results = [];
    
    // Strategy 1: Look for common appointment card patterns
    const cardSelectors = [
      '[class*="booking-card"]',
      '[class*="appointment-card"]',
      '[class*="booking-item"]',
      '[class*="appointment-item"]',
      '[class*="booking"]',
      '[class*="event-card"]',
      '[data-testid*="booking"]',
      '.card',
      'article'
    ];
    
    for (const selector of cardSelectors) {
      const cards = document.querySelectorAll(selector);
      if (cards.length > 0) {
        cards.forEach(card => {
          const text = card.innerText;
          
          const dateMatch = text.match(/(\w+day,?\s+)?(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
          const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(AM|PM)?)\s*(-|to|–)\s*(\d{1,2}:\d{2}\s*(AM|PM)?)/i);
          const singleTimeMatch = text.match(/(\d{1,2}:\d{2}\s*(AM|PM)?)/i);
          
          const h2 = card.querySelector('h2, h3, h4, [class*="title"], [class*="service"]');
          const title = h2?.innerText?.trim() || 'Mathnasium Session';
          
          if (dateMatch || timeMatch) {
            results.push({
              title: title,
              rawText: text.substring(0, 500),
              dateText: dateMatch?.[0],
              timeText: timeMatch?.[0] || singleTimeMatch?.[0],
              startTime: timeMatch?.[1] || singleTimeMatch?.[1],
              endTime: timeMatch?.[4]
            });
          }
        });
        
        if (results.length > 0) break;
      }
    }
    
    // Strategy 2: Look for table rows
    if (results.length === 0) {
      const rows = document.querySelectorAll('tr, [role="row"]');
      rows.forEach(row => {
        const text = row.innerText;
        const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+\s+\d{1,2},?\s+\d{4})/i);
        const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(AM|PM)?)/gi);
        
        if (dateMatch && timeMatch) {
          results.push({
            title: 'Mathnasium Session',
            rawText: text.substring(0, 500),
            dateText: dateMatch[0],
            startTime: timeMatch[0],
            endTime: timeMatch[1]
          });
        }
      });
    }
    
    // Strategy 3: Look for list items
    if (results.length === 0) {
      const items = document.querySelectorAll('li, div[class*="list-item"]');
      items.forEach(item => {
        const text = item.innerText;
        const dateMatch = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\w+\s+\d{1,2},?\s+\d{4})/i);
        const timeMatch = text.match(/(\d{1,2}:\d{2}\s*(AM|PM)?)/gi);
        
        if (dateMatch) {
          results.push({
            title: 'Mathnasium Session',
            rawText: text.substring(0, 500),
            dateText: dateMatch[0],
            startTime: timeMatch?.[0],
            endTime: timeMatch?.[1]
          });
        }
      });
    }
    
    return results;
  });
  
  return appointments.map(apt => parseAppointment(apt));
}

function parseAppointment(rawApt) {
  const appointment = {
    title: rawApt.title || 'Mathnasium Session',
    start: null,
    end: null,
    rawText: rawApt.rawText
  };
  
  let date = null;
  if (rawApt.dateText) {
    date = parseDate(rawApt.dateText);
  }
  
  if (date && rawApt.startTime) {
    appointment.start = parseDateTime(date, rawApt.startTime);
    
    if (rawApt.endTime) {
      appointment.end = parseDateTime(date, rawApt.endTime);
    } else {
      appointment.end = new Date(appointment.start.getTime() + 60 * 60 * 1000);
    }
  }
  
  return appointment;
}

function parseDate(dateStr) {
  const cleaned = dateStr.replace(/,/g, '').trim();
  
  let date = new Date(cleaned);
  if (!isNaN(date.getTime())) {
    return date;
  }
  
  const slashMatch = cleaned.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slashMatch) {
    let [, month, day, year] = slashMatch;
    if (year.length === 2) year = '20' + year;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }
  
  return null;
}

function parseDateTime(date, timeStr) {
  if (!date || !timeStr) return null;
  
  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!timeMatch) return null;
  
  let [, hours, minutes, meridiem] = timeMatch;
  hours = parseInt(hours);
  minutes = parseInt(minutes);
  
  if (meridiem) {
    if (meridiem.toUpperCase() === 'PM' && hours !== 12) {
      hours += 12;
    } else if (meridiem.toUpperCase() === 'AM' && hours === 12) {
      hours = 0;
    }
  }
  
  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

// CLI testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const debug = process.argv.includes('--debug');
  
  scrapeAppointments({ debug })
    .then(appointments => {
      console.log('\n=== Appointments ===');
      appointments.forEach((apt, i) => {
        console.log(`\n${i + 1}. ${apt.title}`);
        console.log(`   Start: ${apt.start}`);
        console.log(`   End: ${apt.end}`);
      });
    })
    .catch(err => {
      console.error('Failed:', err.message);
      process.exit(1);
    });
}
