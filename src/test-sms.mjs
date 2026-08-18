import { sendSmsCampaign } from "./sms.mjs";

const token = requiredEnv("SMSPOP_TOKEN");
const campaignUrl = process.env.SMSPOP_CAMPAIGN_URL ?? "https://smspop.co.zw/api/campaigns";
const senderId = process.env.SMSPOP_SENDER_ID ?? "QikNet";

const recipients = [
  ...splitRecipients(process.env.DEFAULT_OUTAGE_RECIPIENTS),
  ...splitRecipients(process.env.SPECIAL_OUTAGE_RECIPIENT),
  ...splitRecipients(process.env.STOCK_REPORT_RECIPIENT),
];

const uniqueRecipients = [...new Set(recipients)];
if (uniqueRecipients.length === 0) {
  throw new Error("No SMS test recipients are configured.");
}

const requestedMessage = process.env.TEST_SMS_MESSAGE?.trim();
const message = requestedMessage ||
  `QikNet automation test successful at ${new Date().toLocaleString("en-ZW", {
    timeZone: "Africa/Harare",
    dateStyle: "medium",
    timeStyle: "short",
  })}. Voucher and station alerts are ready.`;

console.log(`Sending one QikNet test SMS to ${uniqueRecipients.length} unique configured recipient(s).`);

const results = [];
for (const recipient of uniqueRecipients) {
  const result = await sendSmsCampaign({
    token,
    campaignUrl,
    senderId,
    recipient,
    message,
    campaignName: `QikNet automation test ${new Date().toISOString()}`,
  });
  results.push(result);
  console.log(`Test SMS accepted for ${result.recipient} (HTTP ${result.status}).`);
}

console.log(`SMS test complete: ${results.length}/${uniqueRecipients.length} accepted by SMSPop.`);

function splitRecipients(value) {
  return String(value ?? "")
    .split(",")
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}
