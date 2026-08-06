// netlify/functions/submit-form.js
//
// STRXpo — Unified Form Submission Handler
// ------------------------------------------------------------
// Replaces the old client-side dual-fetch (Formspree + Google Apps Script)
// and eliminates Zapier from the Mailchimp connection entirely.
//
// This function runs server-side, so it can:
//   1. Call Mailchimp's API directly with EXPLICIT tag logic — no more
//      relying on Zapier to correctly interpret a spreadsheet column.
//   2. Make a clean, verifiable request to Google Sheets (server-to-server
//      calls don't have the CORS restriction that forced us into
//      mode:'no-cors' on the old client-side version).
//   3. Report back real success/failure per destination, instead of
//      "fire and forget."
//
// One function handles all 5 forms on the site (pre-registration, Venue
// RFB, Real Estate, Media, Awards nomination) — they already share the
// same field names, so this reads whichever fields are present in each
// submission and doesn't care which page it came from.

const crypto = require('crypto');

exports.handler = async function (event) {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ---- Parse the incoming form data ----
  // The browser will send this as JSON (see the updated form JS).
  let data;
  try {
    data = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request body' }),
    };
  }

  // Pull out the fields we know about. Anything not present just stays
  // an empty string — matches the same schema used across all 5 forms.
  const fullName = data.fullName || '';
  const email = data.email || '';
  const role = data.role || '';
  const phone = data.phone || '';
  const companyName = data.companyName || '';
  const venueName = data.venueName || '';
  const miscData = data.miscData || '';

  if (!email) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Email is required' }),
    };
  }

  // Split fullName into first/last for Mailchimp's merge fields.
  // Mailchimp doesn't have a single "full name" field by default —
  // it expects FNAME and LNAME separately.
  const nameParts = fullName.trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // ---- Environment variables ----
  // Set these in Netlify: Site settings → Environment variables.
  // Never hardcode API keys in the code itself.
  const {
    MAILCHIMP_API_KEY,
    MAILCHIMP_SERVER_PREFIX, // e.g. "us21" — the suffix after the dash in your API key
    MAILCHIMP_AUDIENCE_ID,
    GOOGLE_SHEETS_WEBHOOK_URL,
    FORMSPREE_URL,
  } = process.env;

  // ---- Build all three destination calls ----
  // Each one is wrapped so a failure in one doesn't block the others.

  // 1. Google Sheets (via the existing Apps Script Web App)
  const sheetsPromise = fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      fullName, email, role, phone, companyName, venueName, miscData,
    }).toString(),
  })
    .then((r) => ({ destination: 'sheets', ok: r.ok, status: r.status }))
    .catch((err) => ({ destination: 'sheets', ok: false, error: err.message }));

  // 2. Formspree
  const formspreePromise = fetch(FORMSPREE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      fullName, email, role, phone, companyName, venueName, miscData,
    }),
  })
    .then((r) => ({ destination: 'formspree', ok: r.ok, status: r.status }))
    .catch((err) => ({ destination: 'formspree', ok: false, error: err.message }));

  // 3. Mailchimp — this is the piece that fixes the tagging problem.
  // Two calls: first create/update the subscriber, then explicitly set
  // their tag. The tag value is just "role" verbatim — matching exactly
  // what's already used sitewide (e.g. "Host", "Venue Bid",
  // "Real Estate Brokerage"), so no new tag list to maintain elsewhere.
  const mailchimpPromise = (async () => {
    if (!MAILCHIMP_API_KEY || !MAILCHIMP_SERVER_PREFIX || !MAILCHIMP_AUDIENCE_ID) {
      return { destination: 'mailchimp', ok: false, error: 'Mailchimp env vars not configured' };
    }

    const mcBase = `https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0`;
    const authHeader = 'Basic ' + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString('base64');

    // Mailchimp addresses subscribers by an MD5 hash of their
    // lowercased email — this is just how their API works, not
    // something we're choosing.
    const subscriberHash = crypto
      .createHash('md5')
      .update(email.toLowerCase())
      .digest('hex');

    try {
      // Step 1: create or update the subscriber
      const subscriberRes = await fetch(`${mcBase}/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}`, {
        method: 'PUT',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email_address: email,
          status_if_new: 'subscribed',
          merge_fields: {
            FNAME: firstName,
            LNAME: lastName,
            PHONE: phone,
            COMPANY: companyName,
            VENUE: venueName,
          },
        }),
      });

      if (!subscriberRes.ok) {
        const errBody = await subscriberRes.text();
        return { destination: 'mailchimp', ok: false, status: subscriberRes.status, error: errBody };
      }

      // Step 2: explicitly set the tag — this is the fix. No field
      // mapping, no guessing — the exact "role" value becomes the
      // exact tag, every time.
      if (role) {
        const tagRes = await fetch(`${mcBase}/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash}/tags`, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tags: [{ name: role, status: 'active' }],
          }),
        });

        if (!tagRes.ok) {
          const errBody = await tagRes.text();
          return { destination: 'mailchimp', ok: false, status: tagRes.status, error: `Subscriber created but tag failed: ${errBody}` };
        }
      }

      return { destination: 'mailchimp', ok: true };
    } catch (err) {
      return { destination: 'mailchimp', ok: false, error: err.message };
    }
  })();

  // ---- Run all three at once, wait for all to finish (success or fail) ----
  const results = await Promise.allSettled([sheetsPromise, formspreePromise, mailchimpPromise]);
  const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason }));

  const allSucceeded = outcomes.every((o) => o.ok);

  return {
    statusCode: allSucceeded ? 200 : 207, // 207 = partial success, some destinations failed
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: allSucceeded,
      results: outcomes,
    }),
  };
};
