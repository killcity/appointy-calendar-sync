import crypto from 'crypto';

// Redis REST API helper (Upstash compatible)
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

async function redisSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['SET', key, value])
  });
  const data = await res.json();
  return data.result;
}

async function getConfig() {
  const stored = await redisGet('appointy:config');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  }
  return null;
}

async function saveConfig(config) {
  await redisSet('appointy:config', JSON.stringify(config));
}

// Session management
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now());
  // Clean old sessions
  for (const [t, time] of sessions) {
    if (Date.now() - time > 86400000) sessions.delete(t);
  }
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

export default async function handler(req, res) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  
  // Check if setup is needed
  if (!ADMIN_PASSWORD) {
    return res.send(needsSetupPage('ADMIN_PASSWORD'));
  }
  if (!hasRedis) {
    return res.send(needsSetupPage('UPSTASH'));
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies['admin_session'];
  const isLoggedIn = sessionToken && validateSession(sessionToken);

  // Handle POST requests
  if (req.method === 'POST') {
    const body = req.body || {};
    
    // Login
    if (body.action === 'login') {
      if (body.password === ADMIN_PASSWORD) {
        const token = createSession();
        res.setHeader('Set-Cookie', `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
        return res.redirect(302, '/api/admin');
      }
      return res.send(loginPage('Invalid password'));
    }
    
    // Logout
    if (body.action === 'logout') {
      if (sessionToken) sessions.delete(sessionToken);
      res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
      return res.redirect(302, '/api/admin');
    }
    
    // Save config (requires login)
    if (body.action === 'save' && isLoggedIn) {
      const newConfig = {
        appointyEmail: body.appointyEmail?.trim(),
        appointyPassword: body.appointyPassword?.trim(),
        appointyBookingUrl: body.appointyBookingUrl?.trim() || 'https://mathnasium-booking.appointy.com/portlandme/my-bookings',
        flaresolverrUrl: body.flaresolverrUrl?.trim(),
        calendarToken: body.calendarToken?.trim() || crypto.randomBytes(24).toString('hex'),
        calendarName: body.calendarName?.trim() || 'Mathnasium Appointments',
        updatedAt: new Date().toISOString()
      };
      
      await saveConfig(newConfig);
      return res.redirect(302, '/api/admin?saved=1');
    }
  }

  // Show login page if not logged in
  if (!isLoggedIn) {
    return res.send(loginPage());
  }

  // Load config and show admin panel
  const config = await getConfig() || {};
  const host = req.headers.host || 'localhost';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const saved = req.query.saved === '1';
  
  res.send(adminPage(config, `${protocol}://${host}`, saved));
}

function needsSetupPage(missing) {
  const isUpstash = missing === 'UPSTASH';
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Setup Required</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: linear-gradient(145deg, #18181b 0%, #1f1f23 100%);
      border: 1px solid #27272a;
      border-radius: 16px;
      padding: 40px;
      max-width: 550px;
      width: 100%;
    }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #71717a; margin-bottom: 32px; }
    .step {
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .step-num {
      background: linear-gradient(135deg, #3b82f6, #8b5cf6);
      color: white;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
      margin-right: 12px;
    }
    .step-title { font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; }
    .step-content { color: #a1a1aa; font-size: 14px; line-height: 1.6; }
    code {
      background: #27272a;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: 'SF Mono', monospace;
      font-size: 13px;
      color: #22c55e;
    }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .code-block {
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 16px;
      font-family: 'SF Mono', monospace;
      font-size: 13px;
      margin-top: 12px;
      overflow-x: auto;
      color: #22c55e;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚙️ One-Time Setup</h1>
    <p class="subtitle">${isUpstash ? 'Connect a database to store your config' : 'Set your admin password'}</p>
    
    ${isUpstash ? `
    <div class="step">
      <div class="step-title"><span class="step-num">1</span> Create Free Upstash Account</div>
      <div class="step-content">
        Go to <a href="https://upstash.com" target="_blank">upstash.com</a> and sign up (free, no credit card).
        Create a new Redis database.
      </div>
    </div>
    
    <div class="step">
      <div class="step-title"><span class="step-num">2</span> Copy Your Credentials</div>
      <div class="step-content">
        In your Upstash dashboard, go to your database and find:
        <br>• <code>UPSTASH_REDIS_REST_URL</code>
        <br>• <code>UPSTASH_REDIS_REST_TOKEN</code>
      </div>
    </div>
    
    <div class="step">
      <div class="step-title"><span class="step-num">3</span> Add to Vercel</div>
      <div class="step-content">
        Add both env vars in <a href="https://vercel.com/killcitys-projects/appointy-calendar-sync/settings/environment-variables" target="_blank">Vercel Settings</a>, then redeploy.
        <div class="code-block">
vercel env add UPSTASH_REDIS_REST_URL production
vercel env add UPSTASH_REDIS_REST_TOKEN production
vercel --prod</div>
      </div>
    </div>
    ` : `
    <div class="step">
      <div class="step-title"><span class="step-num">1</span> Set Admin Password</div>
      <div class="step-content">
        Add <code>ADMIN_PASSWORD</code> in <a href="https://vercel.com/killcitys-projects/appointy-calendar-sync/settings/environment-variables" target="_blank">Vercel Settings</a>
        <div class="code-block">vercel env add ADMIN_PASSWORD production</div>
      </div>
    </div>
    `}
  </div>
</body>
</html>`;
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Login - Appointy Sync</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: linear-gradient(145deg, #18181b 0%, #1f1f23 100%);
      border: 1px solid #27272a;
      border-radius: 16px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
      text-align: center;
    }
    .logo { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #71717a; margin-bottom: 32px; }
    input {
      width: 100%;
      padding: 14px 16px;
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 10px;
      color: #fff;
      font-size: 16px;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input:focus { outline: none; border-color: #3b82f6; }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
      border: none;
      border-radius: 10px;
      color: white;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.9; }
    .error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">📅</div>
    <h1>Appointy Sync</h1>
    <p class="subtitle">Login to manage your calendar</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST">
      <input type="hidden" name="action" value="login">
      <input type="password" name="password" placeholder="Admin Password" required autofocus>
      <button type="submit">Login</button>
    </form>
  </div>
</body>
</html>`;
}

function adminPage(config, baseUrl, saved) {
  const calendarUrl = config.calendarToken ? `${baseUrl}/api/calendar/${config.calendarToken}` : null;
  const isConfigured = config.appointyEmail && config.appointyPassword && config.flaresolverrUrl && config.calendarToken;
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Admin - Appointy Sync</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0a0a0f;
      color: #e4e4e7;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 700px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
    }
    h1 { font-size: 28px; display: flex; align-items: center; gap: 12px; }
    .logout-btn {
      background: transparent;
      border: 1px solid #27272a;
      color: #71717a;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
    }
    .logout-btn:hover { border-color: #3f3f46; color: #a1a1aa; }
    .card {
      background: linear-gradient(145deg, #18181b 0%, #1f1f23 100%);
      border: 1px solid #27272a;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .card-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .calendar-url {
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 10px;
      padding: 16px;
      font-family: 'SF Mono', monospace;
      font-size: 14px;
      word-break: break-all;
      color: #22c55e;
      margin-bottom: 12px;
    }
    .copy-btn {
      background: #27272a;
      border: none;
      color: #e4e4e7;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .copy-btn:hover { background: #3f3f46; }
    .instructions {
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 10px;
      padding: 16px;
      margin-top: 16px;
    }
    .instructions h4 { font-size: 14px; margin-bottom: 12px; color: #a1a1aa; }
    .instructions ol { padding-left: 20px; }
    .instructions li { color: #71717a; font-size: 14px; margin-bottom: 8px; line-height: 1.5; }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 8px;
      color: #a1a1aa;
    }
    input[type="text"], input[type="password"], input[type="email"] {
      width: 100%;
      padding: 12px 14px;
      background: #09090b;
      border: 1px solid #27272a;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      margin-bottom: 16px;
    }
    input:focus { outline: none; border-color: #3b82f6; }
    .input-help { font-size: 12px; color: #52525b; margin-top: -12px; margin-bottom: 16px; }
    .save-btn {
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
      border: none;
      color: white;
      padding: 14px 28px;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
    }
    .save-btn:hover { opacity: 0.9; }
    .success {
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #22c55e;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }
    .status-ok { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
    .status-missing { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
    .divider {
      height: 1px;
      background: #27272a;
      margin: 20px 0;
    }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📅 Appointy Sync</h1>
      <form method="POST" style="margin: 0;">
        <input type="hidden" name="action" value="logout">
        <button type="submit" class="logout-btn">Logout</button>
      </form>
    </div>
    
    ${saved ? '<div class="success">✓ Configuration saved successfully!</div>' : ''}
    
    ${calendarUrl ? `
    <div class="card">
      <div class="card-title">🔗 Your Calendar URL</div>
      <div class="calendar-url" id="cal-url">${calendarUrl}</div>
      <button class="copy-btn" onclick="copyUrl()">
        <span id="copy-icon">📋</span>
        <span id="copy-text">Copy URL</span>
      </button>
      
      <div class="instructions">
        <h4>How to Subscribe</h4>
        <ol>
          <li><strong>iPhone/iPad:</strong> Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar</li>
          <li><strong>Mac:</strong> Calendar app → File → New Calendar Subscription</li>
          <li>Paste the URL above and set refresh to "Every hour"</li>
        </ol>
      </div>
    </div>
    ` : ''}
    
    <div class="card">
      <div class="card-title">⚙️ Configuration</div>
      
      <form method="POST">
        <input type="hidden" name="action" value="save">
        
        <label>Appointy Email</label>
        <input type="email" name="appointyEmail" value="${config.appointyEmail || ''}" placeholder="your-email@example.com" required>
        
        <label>Appointy Password</label>
        <input type="password" name="appointyPassword" value="${config.appointyPassword || ''}" placeholder="••••••••" required>
        
        <label>Booking URL</label>
        <input type="text" name="appointyBookingUrl" value="${config.appointyBookingUrl || 'https://mathnasium-booking.appointy.com/portlandme/my-bookings'}" placeholder="https://...">
        <p class="input-help">The my-bookings page URL from Appointy</p>
        
        <div class="divider"></div>
        
        <label>FlareSolverr URL</label>
        <input type="text" name="flaresolverrUrl" value="${config.flaresolverrUrl || ''}" placeholder="https://your-tunnel.trycloudflare.com" required>
        <p class="input-help">FlareSolverr URL (running on your Firewalla)</p>
        
        <div class="divider"></div>
        
        <label>Calendar Access Token</label>
        <input type="text" name="calendarToken" value="${config.calendarToken || ''}" placeholder="Leave empty to auto-generate">
        <p class="input-help">Secret token in your calendar URL. Leave empty to generate automatically.</p>
        
        <label>Calendar Name</label>
        <input type="text" name="calendarName" value="${config.calendarName || 'Mathnasium Appointments'}" placeholder="Mathnasium Appointments">
        
        <button type="submit" class="save-btn">💾 Save Configuration</button>
      </form>
    </div>
    
    <div class="card">
      <div class="card-title">📊 Status</div>
      <p style="margin-bottom: 12px;">
        <span class="status-badge ${config.appointyEmail ? 'status-ok' : 'status-missing'}">
          ${config.appointyEmail ? '✓' : '✗'} Appointy Credentials
        </span>
      </p>
      <p style="margin-bottom: 12px;">
        <span class="status-badge ${config.flaresolverrUrl ? 'status-ok' : 'status-missing'}">
          ${config.flaresolverrUrl ? '✓' : '✗'} FlareSolverr URL
        </span>
      </p>
      <p>
        <span class="status-badge ${config.calendarToken ? 'status-ok' : 'status-missing'}">
          ${config.calendarToken ? '✓' : '✗'} Calendar Token
        </span>
      </p>
      ${config.updatedAt ? `<p style="color: #52525b; font-size: 12px; margin-top: 16px;">Last updated: ${new Date(config.updatedAt).toLocaleString()}</p>` : ''}
    </div>
  </div>
  
  <script>
    function copyUrl() {
      const url = document.getElementById('cal-url').textContent;
      navigator.clipboard.writeText(url).then(() => {
        document.getElementById('copy-icon').textContent = '✓';
        document.getElementById('copy-text').textContent = 'Copied!';
        setTimeout(() => {
          document.getElementById('copy-icon').textContent = '📋';
          document.getElementById('copy-text').textContent = 'Copy URL';
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

export const config = {
  api: { bodyParser: true }
};
