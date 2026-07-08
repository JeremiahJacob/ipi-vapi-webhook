// Vapi "capture_lead" webhook.
// Receives the tool call from the Vivian voice assistant and forwards the
// lead to the same HubSpot form the website chatbot uses, so voice and chat
// leads land in one place (HubSpot portal 148596389). No API key required —
// the HubSpot Forms submission endpoint is public.

const HUBSPOT_FORM =
  "https://api-eu1.hsforms.com/submissions/v3/integration/submit/148596389/9ba8dd8a-44bd-4dc0-8af7-dde018cd285e";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vapi sends the tool call under message.toolCalls (or toolCallList).
  const msg = req.body?.message ?? {};
  const call = (msg.toolCalls ?? msg.toolCallList ?? [])[0];
  const rawArgs = call?.function?.arguments ?? {};
  const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;

  const reply = (result) =>
    res.status(200).json({ results: [{ toolCallId: call?.id, result }] });

  if (!args.email) {
    return reply("Missing email — please ask the caller to confirm their email address.");
  }

  try {
    const hs = await fetch(HUBSPOT_FORM, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "firstname", value: args.firstName ?? "" },
          { name: "email", value: args.email },
          { name: "company", value: args.company ?? "" },
          // Prefer a phone the agent collected; fall back to the caller's own
          // number on inbound phone calls.
          { name: "phone", value: args.phone ?? msg.call?.customer?.number ?? "" },
          { name: "service", value: args.service ?? "" },
        ],
        context: { pageName: "Vapi Voice Agent (Vivian)" },
      }),
    });

    if (!hs.ok) {
      const detail = await hs.text();
      console.error("HubSpot submission failed:", hs.status, detail);
      throw new Error(`HubSpot ${hs.status}`);
    }

    return reply(
      `Lead captured for ${args.firstName || "the caller"}. Our ${args.service || "sales"} team will follow up within one business day.`
    );
  } catch (err) {
    console.error("capture-lead error:", err);
    return reply("Sorry, I couldn't save those details just now — please try again in a moment.");
  }
}
