import ical from 'ical-generator';
import crypto from 'crypto';

const CALENDAR_NAME = process.env.CALENDAR_NAME || 'Mathnasium Appointments';
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';

export function generateCalendar(appointments) {
  const calendar = ical({
    name: CALENDAR_NAME,
    timezone: TIMEZONE,
    prodId: {
      company: 'appointy-calendar-sync',
      product: 'appointy-scraper',
      language: 'EN'
    },
    // Setting TTL to 1 hour - calendar apps will refresh at this interval
    ttl: 60 * 60
  });

  for (const apt of appointments) {
    if (!apt.start) {
      console.warn('Skipping appointment without start time:', apt.title);
      continue;
    }

    // Generate a stable ID based on the appointment content
    const uid = generateUID(apt);

    const event = calendar.createEvent({
      uid,
      start: apt.start,
      end: apt.end || new Date(apt.start.getTime() + 60 * 60 * 1000), // Default 1 hour
      summary: apt.title,
      description: apt.description || '',
      location: apt.location || 'Mathnasium of Portland',
    });

    // Add alarm/reminder 1 hour before
    event.createAlarm({
      type: 'display',
      trigger: -60 * 60, // 1 hour before in seconds
      description: `Reminder: ${apt.title} in 1 hour`
    });

    // Add alarm/reminder 1 day before
    event.createAlarm({
      type: 'display',
      trigger: -24 * 60 * 60, // 1 day before
      description: `Tomorrow: ${apt.title}`
    });
  }

  return calendar;
}

function generateUID(apt) {
  // Create a stable UID based on appointment details
  // This ensures the same appointment always gets the same UID
  const content = `${apt.title}-${apt.start?.toISOString()}-${apt.end?.toISOString()}`;
  const hash = crypto.createHash('md5').update(content).digest('hex');
  return `${hash}@appointy-sync`;
}

export function calendarToICS(calendar) {
  return calendar.toString();
}



