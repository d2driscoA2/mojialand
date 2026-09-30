// Scheduled: the evening phone summary (Release 1.1 #23).
// 00:00 UTC is 8 PM in Michigan in summer and 7 PM in winter.
import { checkEnv } from './_lib/env.mjs';
import { dailySummary } from './_lib/push.mjs';
import { safeErr } from './_lib/db.mjs';

export default async () => {
  const reason = checkEnv(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);
  if (reason) {
    console.error('alerts-daily: refused to start (' + reason + ')');
    return new Response(null, { status: 500 });
  }
  try {
    const sent = await dailySummary();
    console.log('alerts-daily: ' + (sent ? 'sent' : 'skipped'));
  } catch (e) {
    console.error('alerts-daily: failed (' + safeErr(e) + ')');
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: '0 0 * * *' };
