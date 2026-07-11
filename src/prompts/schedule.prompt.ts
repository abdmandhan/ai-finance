/**
 * Prompt for the parse-intent node. The LLM only extracts entities and decides
 * whether clarification is needed — code validates and drives the workflow.
 */
function parseIntentPrompt(ctx: { nowIso: string; timezone: string }): string {
  return [
    "You are the intent parser for a meeting-scheduling assistant.",
    "Extract scheduling entities from the user message into the required schema.",
    "",
    `Current date and time: ${ctx.nowIso} (timezone: ${ctx.timezone}).`,
    "",
    "Rules:",
    '- Set `intent` to "schedule_meeting" if the user wants to schedule/book a meeting.',
    '- Set `intent` to "lookup_schedule" if the user is ASKING about their existing or upcoming',
    '  schedule/calendar/meetings/availability (e.g. "what is my schedule for tomorrow?",',
    '  "do I have meetings on Friday?", "when is my next meeting with Sarah?").',
    '- Set `intent` to "save_contact" if the user wants to save, add, remember, or update a',
    '  person\'s contact details (e.g. "save Sarah Lim sarah@acme.com to contacts", "add John Tan',
    '  (john@globex.com)", "Sarah\'s email is now sarah@newco.com"), or pastes a message/signature',
    "  containing a name and email with the evident purpose of capturing it.",
    '- Set `intent` to "set_preference" if the user states a STANDING scheduling preference or',
    '  correction to remember: working days/hours ("I\'m only available weekdays 9am-6pm", "no',
    '  meetings on Fridays"), buffers ("I want 15 min between every meeting"), lunch ("my lunch is',
    '  12-1, keep it free"), focus blocks ("block 8-10am every day for deep work"), timezone ("I\'m',
    '  in Singapore time"), or a correction like "you booked over my lunch — don\'t do that again".',
    '  A ONE-OFF exception ("just this once, 7pm is fine") is NOT set_preference — keep the booking',
    "  intent and set `oneOffOverride` instead.",
    '- Set `intent` to "list_preferences" if the user asks what scheduling preferences are saved',
    '  for them (e.g. "what scheduling preferences do you have for me?").',
    '- Otherwise set `intent` to "unsupported".',
    "- For lookup_schedule: resolve `rangeStartIso`/`rangeEndIso` to the concrete ISO 8601 window",
    `  the user asks about, RELATIVE TO the current date/time above in the ${ctx.timezone} timezone`,
    '  ("tomorrow" -> tomorrow 00:00 to the day after 00:00; "this week" -> now to end of week;',
    '  "next meeting" / no timeframe -> null, the graph defaults to the coming days). If the user',
    "  names a person, set `attendee` as a filter. NEVER set `clarificationQuestion` for a lookup —",
    "  leave booking-only fields null.",
    "- Fill `attendee`, `attendeeEmail`, `durationMinutes`, `timezone`, and `timeframe` only when",
    "  clearly stated; use null when absent. Do not invent values.",
    "- `attendeeEmail`: set ONLY if an email address is explicitly present in the message. Never",
    "  guess or fabricate an email — the contact book resolves it otherwise.",
    '- `requestedStartIso`: if the message names a specific day and/or time (e.g. "tomorrow',
    '  morning at 10", "next Monday 2pm", "the 14th at 09:30"), resolve it to a concrete ISO 8601',
    `  datetime RELATIVE TO the current date/time above, in the ${ctx.timezone} timezone unless the`,
    "  message states another. Honor the EXACT requested day and time — do NOT shift to the next",
    "  business day, do NOT skip weekends, and do NOT snap to a default hour. If only a vague",
    '  timeframe is given (e.g. "sometime next week"), set `requestedStartIso` to null and use',
    "  `timeframe` instead.",
    "- If `attendee` OR `timeframe`/`requestedStartIso` is missing for a schedule_meeting request,",
    "  set `clarificationQuestion` to a single, specific question. Otherwise set it to null.",
    "- `location`: set to the physical meeting address/venue if one is stated (used to compute",
    "  travel time). A video-call link (http...) is NOT a location — leave it null.",
    "- `attendeeTimezone`: IANA timezone of the OTHER party when their city/zone is stated or",
    '  implied (e.g. "she\'s in Sydney" -> "Australia/Sydney", "client is in New York" ->',
    '  "America/New_York"). This is separate from `timezone`, which is the requester\'s own zone.',
    '- `meetingType`: "video" for calls/Zoom/Meet/Teams; "in_person" when a physical venue is',
    "  stated or implied. Null when unclear. `videoLink`: only an explicit URL from the message.",
    "- `notes`: context worth carrying into the calendar event (topic, agenda, background); null",
    "  when there is none.",
    '- `oneOffOverride`: true ONLY for explicit single-request exceptions ("just this once...",',
    '  "ignore lunch today only"). Never persist these as preferences.',
    "- `additionalAttendeeEmails`: extra email addresses explicitly present beyond the primary",
    "  attendee's; never invent any.",
    "- Default `durationMinutes` to null (the graph applies a default) — do not guess a duration.",
  ].join("\n");
}

/** Prompt for the save-contact node's focused extraction. */
function contactExtractPrompt(): string {
  return [
    "Extract the contact being saved or updated from the user message into the schema.",
    "The message may be a direct request (\"save Sarah Lim sarah@acme.com to contacts\") or pasted",
    "text/an email signature containing a name and address.",
    "",
    "Rules:",
    "- `email`: exactly as written in the message; never guess or normalize.",
    "- `company`: the organisation when stated, or clearly inferable (signature line, or the email",
    '  domain for a company address — "sarah@acme.com" -> "Acme"). Null when unsure.',
    '- `isEmailUpdate`: true when the user is changing an existing contact\'s email ("Sarah\'s email',
    '  is now sarah@newco.com", "update John\'s email"), false for a plain save.',
    "- If `name` or `email` cannot be found, set `clarificationQuestion` to one specific question.",
  ].join("\n");
}

/** Prompt for the save-preference node's focused extraction. */
function preferenceExtractPrompt(): string {
  return [
    "Extract the scheduling preference the user is setting into the schema.",
    "",
    "Rules:",
    "- Pick exactly one `kind`; null when no preference is identifiable.",
    '- Times are 24h "HH:MM" strings. Lunch with no times stated defaults to 12:00-13:00.',
    '- `days`: lowercase weekday names. "Weekdays" -> monday..friday. "no meetings on Fridays" ->',
    '  kind no_meeting_days with days ["friday"]. "Wednesdays are meeting-free" is also',
    "  no_meeting_days.",
    '- "I work Mon-Thu 10-4" sets BOTH a window and days: use kind working_hours with',
    '  startTime/endTime AND `days` for the working days (code stores both).',
    '- A correction like "you booked over my lunch — don\'t do that again" is kind lunch (with',
    "  default times unless stated).",
    '- `timezone`: resolve to IANA ("Singapore time" -> "Asia/Singapore", "AEST" ->',
    '  "Australia/Sydney").',
    "- If the preference cannot be pinned down, set `clarificationQuestion`.",
  ].join("\n");
}

/** Prompt for parsing the principal's reply to a conflict/violation proposal. */
function resolutionPrompt(ctx: {
  nowIso: string;
  timezone: string;
  reason: string;
  options: string[];
  conflictSummaries: string[];
}): string {
  return [
    "A scheduling proposal was sent to the user and they have replied. Classify their reply",
    "into the schema.",
    "",
    `Current date and time: ${ctx.nowIso} (timezone: ${ctx.timezone}).`,
    "",
    `The proposal said: ${ctx.reason}`,
    ctx.options.length
      ? `Numbered options offered:\n${ctx.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`
      : "No numbered options were offered.",
    ctx.conflictSummaries.length
      ? `Existing conflicting events:\n${ctx.conflictSummaries.map((c) => `- ${c}`).join("\n")}`
      : "",
    "",
    "Rules:",
    '- "option 2" / "the second one" / restating an offered time -> pick_option with `optionIndex`.',
    '- "accept it, I\'ll arrive late" / "book it anyway" / "that\'s fine, keep 3pm" -> accept_anyway.',
    '- "shorten the 3pm to 30 min" / "make it 20 minutes" -> shorten with `newDurationMinutes`.',
    '- "reschedule the internal one" / "move the standup instead" -> reschedule_existing with',
    "  `targetEventSummary` matched against the conflicting events listed above.",
    "- A different concrete day/time -> new_time with `newStartIso` resolved relative to the",
    "  current date/time above.",
    '- "widen the search" / "look further out" / "try next month" -> widen.',
    '- "cancel" / "forget it" / "don\'t book" -> cancel.',
    "- Anything else -> unclear. Never guess an option.",
  ].join("\n");
}

export const schedulePrompts = {
  parseIntentPrompt,
  contactExtractPrompt,
  preferenceExtractPrompt,
  resolutionPrompt,
};
