// Code emails through Resend. Skipped (and logged) when EMAIL_API_KEY is missing.
import { codeNoDashes } from './codes.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDetroit(iso) {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Detroit', weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// Release 1.2 #27: wording for passes changed by hand in admin (Add 48 hours,
// Make Forever). Kept in one place: Release 1.4 (#32, 30-day pass) changes it here.
export const ADMIN_CHANGE = {
  how: 'New phone or tablet? Open this email there and tap the button.',
  already: 'Phones and tablets with Mojialand on show the change the next time Mojialand opens.',
};
// Message for a pass with no email on file (gift and manual codes): the admin shares it.
export function adminShareText(plan, pass) {
  if (plan === 'up') return 'Good news: your Mojialand pass is Forever now. Open Mojialand on each phone or tablet and Forever shows up.';
  return 'Good news: we added 48 hours to your Mojialand pass. It now runs until ' + fmtDetroit(pass.ends_at) + '. Open Mojialand on each phone or tablet and the new time shows up.';
}

// Builds {subject, text, html}. The button carries the code and turns the
// pass on for the device that taps it. The code also shows for typing by hand.
export function buildEmail({ plan, pass, code, origin, friend, byAdmin }) {
  const forever = pass.kind === 'forever';
  const subject = {
    pass: 'Mojialand: your 48-hour pass',
    life: 'Mojialand: your Forever pass',
    add: 'Mojialand: 48 hours added',
    up: 'Mojialand: you have Forever',
  }[plan];
  const head = {
    pass: 'You\'re all set for 48 hours!',
    life: 'Mojialand is yours for good!',
    add: 'We added 48 hours!',
    up: 'You have Forever now!',
  }[plan];
  const when = !forever && pass.ends_at ? 'Your pass is on until ' + fmtDetroit(pass.ends_at) + '.' : 'Your Forever pass never ends.';
  const link = code ? origin + '/r/' + codeNoDashes(code) : null;
  const fresh = plan === 'pass' || plan === 'life';
  const how = byAdmin ? ADMIN_CHANGE.how : fresh
    ? 'Open this email on each phone or tablet where you want Mojialand, then tap the button.'
    : 'Open this email on your other phones and tablets, then tap the button to update them.';
  const already = byAdmin ? ADMIN_CHANGE.already : fresh
    ? 'The device you paid on is on already. One pass works on up to 5 devices.'
    : 'The device you paid on is updated already.';
  const byHand = 'Or type the code in Mojialand: open Grown-ups, then tap Have a code?';
  const keep = 'Keep this email. You only need the code if you ever have to show you paid.';
  const preheader = link ? how : when;
  // Friend pass (Release 1.1 #3): one free 48-hour pass to give another family.
  const fLink = friend && friend.code ? origin + friend.path : null;
  const fUntil = friend && friend.use_by ? new Date(friend.use_by).toLocaleDateString('en-US', { timeZone: 'America/Detroit', month: 'long', day: 'numeric' }) : '';
  const fHead = 'Give a friend 48 free hours';
  const fWhy = 'Your pass comes with one free 48-hour pass for another family. It works once, on a device new to Mojialand' + (fUntil ? ', until ' + fUntil : '') + '.';
  const fMsg = 'Here are 48 free hours of Mojialand, emoji games for kids 3 and up. No ads. Tap to play: ' + fLink;
  const fSms = fLink ? 'sms:?&body=' + encodeURIComponent(fMsg) : null;

  const text = [
    head, '', when, '',
    ...(link ? [how, 'Turn on Mojialand: ' + link, '', already, '', byHand, 'Your code: ' + code, '', keep, ''] : []),
    ...(fLink ? [fHead, fWhy, 'Send this link to a friend: ' + fLink, ''] : []),
    'Questions? Reply to this email.', '',
    'Mojialand is made by DisplayedUX: https://displayedux.com',
  ].join('\n');

  const P = '#7138D1', INK = '#30254A', CREAM = '#FFF8E8', DEEP = '#5122A5', SOFT = '#6B6180';
  const F = "Nunito,'Avenir Next','Segoe UI',Helvetica,Arial,sans-serif";
  const button = link ? `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 10px"><tr><td align="center" bgcolor="${P}" style="border-radius:999px">
<a href="${esc(link)}" style="display:block;padding:16px 20px;font:900 19px/1.2 ${F};color:#FFFFFF;text-decoration:none;border-radius:999px">Turn on Mojialand</a>
</td></tr></table>
<p style="margin:0 0 20px;font:700 14px/1.45 ${F};color:${SOFT};text-align:center">${esc(already)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="border-top:2px solid #E9E0F5;padding-top:18px">
<p style="margin:0 0 8px;font:700 14px/1.45 ${F};color:${SOFT};text-align:center">${esc(byHand).replace('Grown-ups', '<span style="white-space:nowrap">Grown-ups</span>')}</p>
<p style="margin:0;font:900 19px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:1px;background:#F3ECFC;color:${DEEP};border-radius:16px;padding:14px 8px;text-align:center">${esc(code)}</p>
</td></tr></table>` : '';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${CREAM}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${CREAM}" style="background:${CREAM}"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px">
<tr><td align="center" style="padding:0 0 18px"><img src="${esc(origin)}/logo/email-logo.png" width="240" height="80" alt="Mojialand" style="display:block;width:240px;height:auto;border:0"></td></tr>
<tr><td bgcolor="#FFFFFF" style="background:#FFFFFF;border-radius:24px;padding:28px 22px;box-shadow:0 4px 12px rgba(0,0,0,.08)">
<p style="margin:0 0 8px;font:900 25px/1.2 ${F};color:${P};text-align:center">${esc(head)}</p>
<p style="margin:0 0 ${link ? 20 : 0}px;font:700 16px/1.45 ${F};color:${INK};text-align:center">${esc(when)}</p>
${link ? `<p style="margin:0 0 14px;font:800 16px/1.45 ${F};color:${INK};text-align:center">${esc(how)}</p>` : ''}${button}
</td></tr>
${fLink ? `<tr><td style="padding:16px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td bgcolor="#FFFFFF" style="background:#FFFFFF;border:2px dashed #FF5FA2;border-radius:24px;padding:22px 20px">
<p style="margin:0 0 6px;font:900 21px/1.2 ${F};color:#FF5FA2;text-align:center">&#127873; ${esc(fHead)}</p>
<p style="margin:0 0 16px;font:700 15px/1.45 ${F};color:${INK};text-align:center">${esc(fWhy)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 10px"><tr><td align="center" bgcolor="#FF5FA2" style="border-radius:999px">
<a href="${esc(fSms)}" style="display:block;padding:14px 20px;font:900 17px/1.2 ${F};color:#FFFFFF;text-decoration:none;border-radius:999px">Text a friend</a>
</td></tr></table>
<p style="margin:0;font:700 13px/1.45 ${F};color:${SOFT};text-align:center">Or send this link any way you like:<br><a href="${esc(fLink)}" style="color:${P};font-weight:800;word-break:break-all">${esc(fLink)}</a></p>
</td></tr></table></td></tr>` : ''}
${link ? `<tr><td style="padding:16px 8px 0"><p style="margin:0;font:700 14px/1.45 ${F};color:${SOFT};text-align:center">${esc(keep)}</p></td></tr>` : ''}
<tr><td style="padding:14px 8px 0"><p style="margin:0;font:700 14px/1.45 ${F};color:${SOFT};text-align:center">Questions? Reply to this email.</p></td></tr>
<tr><td style="padding:6px 8px 0"><p style="margin:0;font:700 13px/1.45 ${F};color:${SOFT};text-align:center">Mojialand is made by <a href="https://displayedux.com" style="color:${P};font-weight:800">DisplayedUX</a></p></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export async function sendEmail(to, msg, replyTo = 'hello@mojialand.com') {
  if (!process.env.EMAIL_API_KEY) {
    console.log('email skipped');
    return false;
  }
  const res = await globalThis.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.EMAIL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      reply_to: replyTo,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    }),
  });
  if (!res.ok) throw new Error('email send failed ' + res.status);
  return true;
}
