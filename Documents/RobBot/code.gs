// RobBot Email Processor with Safe Subject Handling & Error Wrapping
function processInboxWithRobBot() {
  const props = PropertiesService.getScriptProperties();

  const dateKey = new Date().toISOString().split('T')[0]; // e.g., "2025-07-13"
  const usageKey = `DAILY_USED_${dateKey}`;
  let dailyUsed = parseInt(props.getProperty(usageKey) || "0", 10);
  const ignoreList = (props.getProperty("IGNORED_SENDERS") || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(e => e.length > 0);

  const intakeForm = props.getProperty("DEFAULT_INTAKE_URL") || "https://onleylaw.cliogrow.com/intake/ab11020c6901bdd5eef2afc09db57c39";
  const dailyLimit = parseInt(props.getProperty("DAILY_LIMIT") || "3", 10);

  const query = 'is:inbox -label:LeadBotProcessed -subject:(unsubscribe OR "out of office" OR "auto-reply") -from:(no-reply@* noreply@* info@* mailer-daemon@* notifications@* trish@* DONOTREPLY@* support@*) newer_than:1d';
  const threads = GmailApp.search(query);
  Logger.log(`🔍 Found ${threads.length} thread(s) matching the query.`);

  if (threads.length === 0) {
    Logger.log("❌ No matching threads. Exiting.");
    return;
  }

  let processedCount = 0;
  threads.forEach(thread => {
    try {
      if (dailyUsed >= dailyLimit) {
      Logger.log(`🚫 Daily limit of ${dailyLimit} reached. Exiting.`);
      return;
}
      const msg = thread.getMessages()[0];
      let body = msg.getPlainBody();
      let subject = msg.getSubject();
      const fromEmail = msg.getFrom();
      const lowerFrom = fromEmail.toLowerCase();

      const myEmails = ["robert@onleylaw.ca"]; // 🔁 Add all your possible sender addresses

      if (myEmails.some(myEmail => lowerFrom.includes(myEmail.toLowerCase()))) {
      Logger.log(`⏭️ Skipping thread because it was sent by me: ${fromEmail}`);
      return;
}

      if (!subject || subject.length > 1000) {
        Logger.log(`⏭️ Skipping due to invalid or oversized subject: ${subject?.slice(0, 100)}...`);
        return;
      }
      if (!body || body.length > 10000) {
        Logger.log("⏭️ Skipping due to empty or oversized body.");
        return;
      }

      const wordCount = body.split(/\s+/).filter(Boolean).length;

      if (ignoreList.some(ignored => lowerFrom.includes(ignored))) {
        Logger.log(`⏭️ Skipping ignored sender: ${fromEmail}`);
        return;
      }

      const isClioGrow = lowerFrom.includes("no-reply@grow.clio.com") && subject.includes("New Clio Grow Inbox Lead");

      if (wordCount < 25) {
        const fallbackReply = `Hi there,\n\nThanks for reaching out to Onley Law. Could you kindly provide a bit more detail about your legal issue?\n\n👉 Once you're ready, please complete our secure intake form here: ${intakeForm}\n\nBest regards,  \nRob Onley  \nManaging Lawyer`;
        msg.createDraftReply(fallbackReply);
        thread.addLabel(getOrCreateLabel_('LeadBotProcessed'));
        Logger.log(`🟡 Fallback reply to: ${fromEmail} — Subject: ${subject}`);
        processedCount++;
        return;
      }

      if (isClioGrow) {
        const clioReply = `Hi there,\n\nThanks for reaching out to Onley Law. We’d be happy to assist.\n\n👉 Please complete our secure intake form so we can learn more: ${intakeForm}\n\nWe look forward to connecting soon.\n\nBest regards,  \nRob Onley  \nManaging Lawyer`;
        msg.createDraftReply(clioReply);
        thread.addLabel(getOrCreateLabel_('LeadBotProcessed'));
        Logger.log(`🟢 Clio Grow lead reply to: ${fromEmail}`);
        processedCount++;
        return;
      }

      const trimmedSubject = subject.length > 300 ? subject.substring(0, 300) + '...' : subject;
      const trimmedBody = body.length > 5000 ? body.substring(0, 5000) + '...' : body;

      const aiReply = generateReplyWithOpenAI(trimmedBody, trimmedSubject, fromEmail, intakeForm);
      if (aiReply) {
      const cleanedReply = aiReply.replace(/^\s*Subject:.*\n+/i, '').trim();
      msg.createDraftReply(cleanedReply); // ✅ DO NOT pass subject as second argument
      thread.addLabel(getOrCreateLabel_('LeadBotProcessed'));
      Logger.log(`🧠 AI reply to: ${fromEmail} — Subject: ${trimmedSubject}`);

      // 🔐 Update persistent usage tracking
      props.setProperty(usageKey, String(dailyUsed + 1));
      dailyUsed++;
      processedCount++;
}
    } catch (err) {
      Logger.log(`⚠️ Error processing thread: ${err}`);
    }
  });
}

function generateReplyWithOpenAI(emailBody, subject, senderEmail, intakeForm) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY");
  if (!apiKey) {
    Logger.log("❌ No OpenAI API key found. Set OPENAI_API_KEY in script properties.");
    return null;
  }

  const systemPrompt = `
You are Robert Onley, a corporate business and technology lawyer in Ontario who responds confidently, professionally, and efficiently to prospective clients by email.

You NEVER mention hourly rates. You NEVER provide fee estimates or request deposits in your first reply.

You always include the official Clio Grow intake form at the end of every message to ask the client to complete it:
👉 https://onleylaw.cliogrow.com/intake/ab11020c6901bdd5eef2afc09db57c39

If the message is vague or lacks legal relevance, politely prompt for more information.

Tone: Clear, courteous, direct, and efficient — no fluff.
`;

  const userPrompt = `You received the following email from a prospective client:\n\nFrom: ${senderEmail}\nSubject: ${subject}\n\nMessage:\n${emailBody}\n\nWrite a reply in Rob Onley's tone.`;

  const payload = {
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: userPrompt.trim() }
    ],
    temperature: 0.3,
    max_tokens: 400
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", options);
    const json = JSON.parse(response.getContentText());
    Logger.log("📨 Raw OpenAI response: " + response.getContentText());

    if (json && json.choices && json.choices.length > 0 && json.choices[0].message) {
      return json.choices[0].message.content.trim();
    } else {
      Logger.log("⚠️ Unexpected OpenAI response: " + JSON.stringify(json));
      return null;
    }
  } catch (e) {
    Logger.log("❌ OpenAI API error: " + e.message);
    return null;
  }
}

function getOrCreateLabel_(name) {
  const label = GmailApp.getUserLabelByName(name);
  return label || GmailApp.createLabel(name);
}
