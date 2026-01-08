# Appointy Calendar Sync

Sync your Appointy bookings to an iCal calendar feed. Subscribe in Apple Calendar, Google Calendar, or any calendar app that supports webcal subscriptions.

## Features

- **Automated scraping** with Puppeteer and stealth mode to bypass Cloudflare
- **Lazy-load handling** - automatically scrolls to load all appointments
- **15-minute cache** - reduces load on Appointy servers
- **Token-protected** calendar URL
- **Admin panel** for easy configuration
- **Docker deployment** - runs on any x86_64 machine

## Quick Start (Docker)

```bash
# Clone and enter directory
git clone https://github.com/killcity/appointy-calendar-sync.git
cd appointy-calendar-sync

# Build and run
docker-compose up -d

# Access admin panel
open http://localhost:3000/admin
```

## Setup

1. **Access the admin panel** at `http://YOUR_IP:3000/admin`
2. **First-time setup**: Enter admin password, Appointy email/password, and booking URL
3. **Get your calendar URL** from the admin panel
4. **Subscribe** in your calendar app using the webcal URL

## Calendar Subscription

**WebCal URL format:**
```
webcal://YOUR_IP:3000/calendar/YOUR_TOKEN
```

**Apple Calendar:**
1. File → New Calendar Subscription
2. Paste the URL
3. Set refresh to "Every hour"

## Files

```
├── src/
│   └── server.js      # Main application (Express + Puppeteer)
├── Dockerfile         # Docker image with Chrome
├── docker-compose.yml # Container orchestration
└── package.json       # Dependencies
```

## Technical Details

- **Base image**: `zenika/alpine-chrome:with-node` (~300MB)
- **Browser**: Chromium with puppeteer-extra stealth plugin
- **Cache TTL**: 15 minutes
- **Scrape time**: 3-5 minutes (login + scroll through all appointments)

## Refresh Behavior

- Calendar data cached for 15 minutes
- Calendar apps typically refresh hourly
- Force refresh: add `?refresh=true` to calendar URL

## License

MIT
