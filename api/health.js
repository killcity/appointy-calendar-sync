export default async function handler(req, res) {
  const hasRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  
  let redisStatus = 'not configured';
  let config = null;
  
  if (hasRedis) {
    try {
      const response = await fetch(
        `${process.env.UPSTASH_REDIS_REST_URL}/get/appointy:config`,
        { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
      );
      const data = await response.json();
      if (data.result) {
        config = JSON.parse(data.result);
        redisStatus = 'connected';
      } else {
        redisStatus = 'connected (no config)';
      }
    } catch (e) {
      redisStatus = `error: ${e.message}`;
    }
  }
  
  // Test FlareSolverr if configured
  let flaresolverrStatus = 'not configured';
  if (config?.flaresolverrUrl) {
    try {
      const testRes = await fetch(`${config.flaresolverrUrl}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'sessions.list' }),
        signal: AbortSignal.timeout(5000)
      });
      const testData = await testRes.json();
      flaresolverrStatus = testData.status === 'ok' ? 'connected' : 'error';
    } catch (e) {
      flaresolverrStatus = `unreachable: ${e.message}`;
    }
  }
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    redis: redisStatus,
    flaresolverr: flaresolverrStatus,
    configured: {
      appointyEmail: !!(config?.appointyEmail),
      appointyPassword: !!(config?.appointyPassword),
      flaresolverrUrl: !!(config?.flaresolverrUrl),
      calendarToken: !!(config?.calendarToken),
      adminPassword: !!process.env.ADMIN_PASSWORD,
    }
  });
}
