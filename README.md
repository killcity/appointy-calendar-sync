# Appointy Calendar Sync

Syncs your Appointy bookings (from the customer portal) to an iCal feed that you can subscribe to from Apple Calendar.

## The Problem

Appointy's built-in calendar sync only works for business owners. If you're a **customer** viewing your bookings at `/my-bookings`, there's no official way to sync those to your personal calendar.

This tool scrapes your booking page and generates a subscribable iCal feed.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fkillcity%2Fappointy-calendar-sync)

### Required Environment Variables

Set these in your Vercel project settings:

| Variable | Description |
|----------|-------------|
| `CALENDAR_TOKEN` | Secret token to protect your calendar (generate with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`) |
| `BROWSERLESS_TOKEN` | API key from [browserless.io](https://browserless.io) (free tier: 1000 req/month) |
| `APPOINTY_EMAIL` | Your Appointy login email |
| `APPOINTY_PASSWORD` | Your Appointy password |
| `APPOINTY_BOOKING_URL` | Your booking URL (e.g., `https://mathnasium-booking.appointy.com/portlandme/my-bookings`) |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CALENDAR_NAME` | "Mathnasium Appointments" | Name shown in your calendar app |

## Subscribe to Your Calendar

Once deployed, your calendar URL will be:

```
https://your-app.vercel.app/cal/YOUR_TOKEN/calendar.ics
```

Or:

```
https://your-app.vercel.app/api/calendar/YOUR_TOKEN
```

### Apple Calendar (macOS)
1. File → New Calendar Subscription
2. Paste your full URL with token
3. Set auto-refresh to "Every hour"

### Apple Calendar (iOS)
1. Settings → Calendar → Accounts → Add Account → Other
2. Add Subscribed Calendar
3. Paste your full URL with token

## Local Development

```bash
# Install dependencies
npm install

# Copy env template
cp env.template .env
# Edit .env with your credentials

# Run locally
npm start
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Homepage with setup instructions |
| `GET /api/calendar/:token` | iCal feed (protected) |
| `GET /cal/:token/calendar.ics` | iCal feed alias (protected) |
| `GET /api/health` | Health check (shows which env vars are set) |

## How It Works

1. Uses [Browserless.io](https://browserless.io) for cloud browser automation (works on Vercel serverless)
2. Logs into your Appointy customer portal
3. Extracts appointment data from the bookings page
4. Generates an iCal calendar with reminders
5. Caches for 15 minutes to avoid hammering Appointy

## Troubleshooting

### "BROWSERLESS_TOKEN not configured"
Get a free API key at [browserless.io](https://browserless.io). The free tier includes 1000 requests/month.

### No appointments found
1. Verify your Appointy credentials are correct
2. Check that you have upcoming appointments
3. The page structure may have changed - open an issue

### Login failed
1. Verify credentials in Vercel environment variables
2. Make sure your Appointy account doesn't have 2FA enabled
3. Try logging in manually to confirm the account works

## Security

- Your calendar is protected by a secret token
- Credentials are stored as environment variables (never in code)
- Token comparison uses constant-time comparison to prevent timing attacks

## License

MIT
