// api/lead-gen.js
//
// Automated B2B lead generation for Iron Products Industries (IPI).
// Triggered weekly by Vercel Cron. For each IPI division, asks Claude
// (with web search) to find companies showing a genuine buying signal,
// dedupes against existing HubSpot records, and creates new Company
// (and Contact, if an email was found) records in HubSpot.
//
// Required environment variables (set in Vercel > Project > Settings > Environment Variables):
//   ANTHROPIC_API_KEY   - your Anthropic API key
//   HUBSPOT_ACCESS_TOKEN - HubSpot private app token (same one used by capture-lead.js)
//   CRON_SECRET         - any random string; Vercel auto-sends it as the Bearer token
//                          on scheduled invocations once this env var is set
//
// Deploy: place this file at api/lead-gen.js in your existing ipi-vapi-webhook
// repo (same repo as capture-lead.js), and add the cron entry from
// vercel.json (see accompanying file) to your project's vercel.json.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HUBSPOT_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

// Claude model used for search + extraction. Swap to 'claude-haiku-4-5-20251001'
// for a cheaper/faster run once you've validated lead quality.
const MODEL = 'claude-sonnet-5';

// Matches the four exact values of the HubSpot "service" dropdown property.
const DIVISIONS = [
  {
    key: 'Steel Fabrication',
    prompt:
      'Find Nigerian or West African construction firms, real estate developers, ' +
      'or infrastructure contractors that have recently announced or tendered projects ' +
      'requiring structural steel fabrication, steel frames, tanks, or metal works. ' +
      'Check tenders.ng, Nigerian construction news, and general web search. ' +
      'Prioritize signals from the last 60 days.'
  },
  {
    key: 'Oil & Gas',
    prompt:
      'Find oil & gas operators, marginal field companies, or EPC contractors in Nigeria ' +
      'with active or upcoming projects needing fabrication, engineering, procurement, ' +
      'or construction (EPC) partners. Check NUPRC / NipeX bid portals and oil & gas ' +
      'industry news. Prioritize signals from the last 60 days.'
  },
  {
    key: 'Automotive & Trailers',
    prompt:
      'Find Nigerian logistics companies, haulage firms, or fleet operators that may need ' +
      'trailers, truck bodies, or automotive assembly/fabrication services. Check transport ' +
      'industry news and business directories. Prioritize signals from the last 60 days.'
  },
  {
    key: 'Other Services',
    prompt:
      'Find Nigerian companies in paints, industrial chemicals, or general logistics/' +
      'distribution that could be prospective B2B customers for an industrial conglomerate ' +
      'offering paints, chemicals, and logistics services. Prioritize signals from the last 60 days.'
  }
];

function cleanDomain(website) {
  if (!website) return null;
  return website
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
    .toLowerCase()
    .trim();
}

async function findLeadsForDivision(division) {
  const systemPrompt = `You are a B2B lead research assistant for Iron Products Industries (IPI), a Nigerian industrial conglomerate. ${division.prompt}

Respond ONLY with a JSON array (no markdown fences, no preamble, no explanation) of up to 8 candidates. Each object must have exactly these fields:
{
  "company_name": string,
  "website": string or null,
  "evidence_summary": string (1-2 sentences, written in your own words, no quoted text from sources),
  "source_url": string,
  "contact_email": string or null,
  "contact_phone": string or null,
  "confidence_score": integer from 1 to 10
}
Only include companies with a genuine, evidenced signal of need — not generic directory listings. If nothing qualifies, return [].`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      // Generous budget: web search reasoning + tool calls eat into this
      // budget before the model ever writes the final JSON, so a low limit
      // here silently truncates the JSON output rather than erroring.
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Find candidates for division: ${division.key}` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();

  if (data.stop_reason === 'max_tokens') {
    throw new Error(
      `Response truncated (hit max_tokens) before JSON completed. Raise max_tokens further or reduce candidates requested.`
    );
  }

  const textBlocks = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const cleaned = textBlocks.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // Surface this as a real error instead of silently returning zero leads,
    // so a parsing regression shows up in the response body, not just logs.
    throw new Error(`Failed to parse model output as JSON: ${cleaned.slice(0, 300)}`);
  }
}

async function hubspotSearchCompanyByDomain(domain) {
  if (!domain) return null;
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }],
      limit: 1
    })
  });
  if (!res.ok) {
    throw new Error(`HubSpot company search error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.results && data.results.length ? data.results[0] : null;
}

async function createHubspotCompany(lead, divisionKey) {
  const domain = cleanDomain(lead.website);
  const properties = {
    name: lead.company_name,
    service: divisionKey,
    lead_source: 'AI Lead Generation',
    lifecyclestage: 'lead'
  };
  if (domain) properties.domain = domain;

  const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties })
  });
  if (!res.ok) {
    throw new Error(`HubSpot create company error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function createHubspotContact(lead, divisionKey, companyId) {
  if (!lead.contact_email) return null;

  const properties = {
    email: lead.contact_email,
    company: lead.company_name,
    service: divisionKey,
    lead_source: 'AI Lead Generation',
    lifecyclestage: 'lead'
  };
  if (lead.contact_phone) properties.phone = lead.contact_phone;

  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties })
  });
  if (!res.ok) {
    throw new Error(`HubSpot create contact error ${res.status}: ${await res.text()}`);
  }
  const contact = await res.json();

  if (companyId && contact.id) {
    await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}/associations/companies/${companyId}/contact_to_company`,
      { method: 'PUT', headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );
  }

  return contact;
}

const MIN_CONFIDENCE = 5;

// Extends this function's max execution time beyond Vercel's default.
// Note: Hobby plan caps this at 60s regardless of what's set here; Pro
// plans can go up to 300s. If runs still time out on Hobby even with
// divisions running in parallel, the plan itself is the limiting factor.
export const config = {
  maxDuration: 300
};

export default async function handler(req, res) {
  if (!CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!ANTHROPIC_API_KEY || !HUBSPOT_TOKEN) {
    return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY or HUBSPOT_ACCESS_TOKEN' });
  }

  const summary = { created: [], skipped: [], errors: [] };

  // Run all 4 divisions' web searches concurrently instead of one after
  // another — this is what was causing the timeout, since 4 sequential
  // search+generation calls can easily add up to 2-3+ minutes.
  const divisionResults = await Promise.allSettled(
    DIVISIONS.map((division) => findLeadsForDivision(division))
  );

  for (let i = 0; i < DIVISIONS.length; i++) {
    const division = DIVISIONS[i];
    const result = divisionResults[i];

    let leads = [];
    if (result.status === 'rejected') {
      summary.errors.push({ division: division.key, stage: 'search', error: String(result.reason) });
      continue;
    }
    leads = result.value;

    for (const lead of leads) {
      try {
        if (!lead.company_name || (lead.confidence_score ?? 0) < MIN_CONFIDENCE) {
          summary.skipped.push({
            company: lead.company_name || '(unnamed)',
            reason: 'below confidence threshold'
          });
          continue;
        }

        const domain = cleanDomain(lead.website);
        const existing = await hubspotSearchCompanyByDomain(domain);
        if (existing) {
          summary.skipped.push({ company: lead.company_name, reason: 'already in HubSpot' });
          continue;
        }

        const company = await createHubspotCompany(lead, division.key);
        let contact = null;
        if (lead.contact_email) {
          contact = await createHubspotContact(lead, division.key, company.id);
        }

        summary.created.push({
          company: lead.company_name,
          division: division.key,
          confidence: lead.confidence_score,
          contactCreated: !!contact,
          sourceUrl: lead.source_url
        });
      } catch (e) {
        summary.errors.push({ company: lead.company_name, error: String(e) });
      }
    }
  }

  return res.status(200).json(summary);
}
