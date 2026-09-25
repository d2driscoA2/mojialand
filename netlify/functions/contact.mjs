// POST {email, topic, message, session_id?} -> {ok:true}
// The in-app contact form. Saves the message and emails it to the support inbox.
// Succeeds if either the save or the email works, so a parent is never stuck.
import { guard } from './_lib/env.mjs';
import { json, fail, readJson, clientIp } from './_lib/http.mjs';
import { rateHit, addSupportMessage, safeErr } from './_lib/db.mjs';
import { sendEmail } from './_lib/email.mjs';

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const TOPICS = { pass: 'My pass', broken: 'Something is broken', refund: 'Refund', other: 'Other' };
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,185}\.[A-Za-z]{2,24}$/;
const SID_RE = /^cs_(test|live)_[A-Za-z0-9]{1,200}$/;
const SUPPORT_TO = 'hello@mojialand.com';

export const handler = async (event) => {
  const stop = guard('contact', REQUIRED);
  if (stop) return stop;
  if (event.httpMethod !== 'POST') return fail(405, 'Use POST.');

  const input = readJson(event);
  if (!input) return fail(400, 'Please fill in the form.');
  const email = String(input.email || '').trim();
  const topic = TOPICS[input.topic] ? input.topic : 'other';
  const message = String(input.message || '').trim().slice(0, 2000);
  const sid = SID_RE.test(String(input.session_id || '')) ? input.session_id : '';
  if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, 'Please check your email address.');
  if (message.length < 2) return fail(400, 'Please tell us a little about it.');

  const ip = clientIp(event);
  if (!(await rateHit('contact', ip, 5, 3600, { failOpen: true }))) return fail(429, 'Too many messages. Please try again later.');

  const body = message + (sid ? '\n\nPayment: ' + sid : '');
  let saved = false;
  let mailed = false;
  try {
    await addSupportMessage({ email, topic, message: body });
    saved = true;
  } catch (e) {
    console.error('contact: save failed (' + safeErr(e) + ')');
  }
  try {
    mailed = await sendEmail(SUPPORT_TO, {
      subject: 'Mojialand: contact form, ' + TOPICS[topic],
      text: 'From: ' + email + '\nTopic: ' + TOPICS[topic] + '\n\n' + body + '\n\nReply to this email to answer.',
    }, email);
  } catch (e) {
    console.error('contact: email failed (' + safeErr(e) + ')');
  }
  if (!saved && !mailed) return fail(500, 'We could not send that. Please try again in a minute.');
  console.log('contact: message received (' + topic + ')');
  return json(200, { ok: true });
};
