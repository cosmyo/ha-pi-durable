# Research: Hearth Pi — product brief (use cases, competition, apps on demand, self-improvement, Home World, roadmap)

_Research date: October 2026. Scope: an independent, experimental Home Assistant App built on Pi Durable. All design proposals stay inside the project's hard security rules: no shell, filesystem, config-write, Supervisor-admin or Docker tools in the controller or Home conversations; no model-written HTML/JS in the controller UI; service calls only through exact configured scopes plus approval rules; unknown outcomes are never retried automatically; credentials never appear in prompts, logs or the browser; code changes happen only in the separate offline worker and need human review._

## Summary

The pieces that would make Hearth Pi a "Swiss army knife" are already proven elsewhere: grounded home briefings, plain-language explanations of history and automations, and generated mini-apps. The weak spots are also well documented. Alexa+ and Gemini for Home are widely criticized for **making up device states and claiming actions that didn't happen**, and Google's own generative-UI research reports **slow generation (sometimes a minute or more) and occasional inaccuracies**. Hearth Pi's winning position is the reverse of those products: **the model chooses what to show, the controller supplies every value, and every change to the home goes through an approval broker**. "Apps on demand" should be a small typed component catalog in the style of A2UI and json-render (flat element map, catalog-constrained, values bound from data rather than written by the model), stored as versioned household objects. "Self-improvement" should be an inbox of proposals with diffs (memory, prompts, apps, canvas, watchers), where approval is enforced by the controller and never asserted by the model. Code-level fixes should be drafted as patches in the offline Code worker and applied only by the owner through a normal release.

## Key findings (cross-cutting)

1. **HA's own direction validates "AI as a scoped tool, not a takeover."** HA routes commands to Assist first and sends only what Assist can't understand to the LLM. It shares context between agents and lets automations _start_ conversations, for example asking whether to close an open garage door. AI Tasks return **structured JSON matching a schema** for use in automations. HA explicitly lets users "exclude it from mission-critical things." [HA blog, Sep 2025](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant/) · [2025.8 release](https://www.home-assistant.io/blog/2025/08/06/release-20258/)
2. **HA makes outside AI clients easy to connect, so Hearth must differentiate on safety, durability and UI.** The 2026.10 release added "Connect your AI in one click" through HA's MCP server for Claude, ChatGPT and Cursor. [HA 2026.10](https://www.home-assistant.io/blog/2026/10/07/release-202610/) The community calls Claude + ha-mcp "next level" for troubleshooting. Others warn that self-hosters "would be creeped out by letting Claude run amok." [Reddit](https://www.reddit.com/r/homeassistant/comments/1rvn71u/i_was_skeptical_at_first_but_claude_mcp_with_ha/) · [Reddit](https://www.reddit.com/r/homeassistant/comments/1pf7snh/control_home_assistant_with_claudeai_no/) · [How-To Geek](https://www.howtogeek.com/letting-claude-take-control-of-home-assistant/)
3. **The biggest consumer complaint is false success and made-up state.** WIRED says Alexa+ "claimed multiple times that it was actually playing an episode when it was in fact not." [WIRED](https://www.wired.com/story/why-is-amazon-alexa-plus-so-bad/) Consumer Reports calls the Alexa app "clunky and slow." [CR](https://www.consumerreports.org/electronics/digital-assistants/amazon-alexa-plus-ai-assistant-review-a1667486499/) Gemini "often insists it did things correctly, even when it didn't do anything at all." [SlashGear](https://www.slashgear.com/2025559/can-gemini-ai-make-google-home-less-awful-answer/) Gemini's Home Briefs "leaned more toward fiction than fact." [The Verge](https://www.theverge.com/tech/813523/gemini-for-home-google-nest-camera-hands-on) Wirecutter calls it "plagued by AI hallucinations… fundamentally untrustworthy." [Wirecutter](https://www.nytimes.com/wirecutter/reviews/google-gemini-for-home-review/) → Hearth's rule that "the controller reads real HA values" and its "unknown outcome" state are **core product features**, not plumbing.
4. **Declarative generative UI is now a standard pattern with clear lessons.**
   - A2UI: "declarative data, not code… agent requests components from client's trusted catalog." It uses a flat component list with ID references because that is "easy to generate incrementally, correct mistakes, stream," and keeps UI structure, data model and rendering separate. [A2UI](https://a2ui.org/introduction/what-is-a2ui/)
   - json-render: a catalog of components with Zod prop schemas, so "invalid output fails validation instead of rendering." It supports `$state`, `$cond` and `$template` bindings and named actions. [json-render README](https://github.com/vercel-labs/json-render/blob/main/README.md)
   - MCP Apps (the standard behind Claude and ChatGPT apps) does the opposite: it runs **server HTML/JS in sandboxed iframes** with consent for UI-initiated tool calls. [MCP blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) That is incompatible with Hearth's no-model-JS rule. → Hearth should follow the A2UI/json-render model.
5. **Generated UI is preferred by users, but slow and sometimes wrong.** In Google's tests, raters strongly preferred generated interfaces _when generation speed was ignored_. Generation "can sometimes take a minute or more," and "there are occasional inaccuracies." [Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/) → Generate once, **save and reuse** apps, patch them incrementally, and keep the specs small.
6. **Proactive "curated cards" are the 2025–26 pattern.** ChatGPT Pulse researches overnight and delivers "topical visual cards." [OpenAI](https://openai.com/index/introducing-chatgpt-pulse/) Meta's Muse shows morning briefings on e-ink, can reach Home Assistant through a Raspberry Pi 5, and does tasks "with your approval." [TechMyMoney](https://techmymoney.com/2026/10/02/meta-muse-gadgets-opens-the-ai-agent-to-diy-hardware-with-a-free-home-link-for-us-subscribers/) · [Google Play listing](https://play.google.com/store/apps/details?id=com.facebook.aura&hl=en_US)
7. **Prompt injection from the home itself is an open risk.** Research on smart-home agents describes injected instructions that "naturally appear in the surrounding environment," for example on a TV or in text the agent sees. The core challenge is "source attribution and action authorization." [PromptShield Home (arXiv)](https://arxiv.org/html/2608.05495) · [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) → Notes and checklist text in apps, entity names and calendar text must all be treated as untrusted data. Approvals stay with the human.
8. **Common self-improvement loops are only as safe as their approval gate.** BerriAI's self-improving-agent has the agent propose a minimal diff that a human approves before a draft PR opens. But one of its gates is a schema flag the _model_ sets (`userConfirmedInThisMessage: true`). [BerriAI](https://github.com/BerriAI/self-improving-agent) Microsoft's SkillOpt argues for "propose-and-test optimization rather than unconditional self-editing" and notes that "rejected updates are still useful." [SkillOpt (arXiv)](https://arxiv.org/pdf/2605.23904) → In Hearth, approval must be a controller-side event from a human tap, and rejections should be remembered.
9. **Living home maps work when they are status monitors first.** A pixel-art Pokémon-style HA floor plan went viral. It "reflects the current state," shows which lights are on at a glance in its night view, and acts as a remote (tap to toggle, long-press for more). Building it took "serious time and effort" in GIMP, and the reviewer said such dashboards "always seemed like too much effort to set up." [How-To Geek](https://www.howtogeek.com/pokemon-style-home-assistant-dashboard/) → Generate the world automatically from HA areas and floors. Never require the user to draw it.

---

## 1. Use cases — top 25, ranked by value × feasibility

**Modes:** **R** = read-only answer or display · **P** = proactive monitoring (controller-side watcher or schedule; the model summarizes but never acts on its own) · **A** = action (light/switch only, through Home permissions).
**Risk:** L = low, M = medium, H = high (safety, privacy or trust).
**Scores:** Value (V) and Feasibility (F) on a 1–5 scale. F reflects the current architecture: read-only by default, light/switch actions only, no config writes.

| #   | Use case                                               | User story                                                                                                                           | Data / capabilities                                                                                | Mode    | Risk        | V   | F   | V×F |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------- | ----------- | --- | --- | --- |
| 1   | **Morning / evening home briefing**                    | "At 7:00, tell me the weather, today's calendar, bin day, anything left open, and yesterday's energy use."                           | weather, calendar, binary_sensor (doors/windows), energy statistics, todo                          | R+P     | L           | 5   | 5   | 25  |
| 2   | **"What's still on or open?" bedtime / leaving check** | "Before bed: what lights are on, which doors and windows are open, is the garage closed?" Offers "turn off the 4 lights"             | light, switch, cover, lock, binary_sensor states; light/switch off via Ask                         | R+A     | L–M         | 5   | 5   | 25  |
| 3   | **Explain history and graphs**                         | "Why was the bedroom cold last night?" "When did the freezer last go above −15 °C?"                                                  | recorder history and statistics, logbook                                                           | R       | L           | 5   | 5   | 25  |
| 4   | **Automation troubleshooting**                         | "Why didn't the hallway light come on at 23:10?"                                                                                     | automation configs (read), traces, logbook, entity history; _drafts_ fixes as text only            | R       | L           | 5   | 4   | 20  |
| 5   | **Device health report**                               | "What's unavailable, low on battery, or hasn't reported in 24 h?"                                                                    | entity registry, battery sensors, last_changed / last_reported                                     | R+P     | L           | 4   | 5   | 20  |
| 6   | **Maintenance reminders**                              | "Remind me to change the HVAC filter every 90 days, and track smoke alarm tests."                                                    | app-local schedules + reminders; optional runtime sensors                                          | P       | L           | 4   | 5   | 20  |
| 7   | **Room / topic Home canvas**                           | "Make me a kitchen panel: fridge temperature, dishwasher state, lights."                                                             | entity tiles, charts (declarative app)                                                             | R(+A)   | L           | 4   | 5   | 20  |
| 8   | **Lighting scenes on request**                         | "Make the living room cosy for a movie." → exact light calls shown for approval                                                      | light services within configured scope                                                             | A       | L–M         | 4   | 5   | 20  |
| 9   | **Appliance finished / needs attention**               | "Tell me when the washer finishes; nag me if wet laundry sits for 30 min." "How's the 3D print, and did it fail?"                    | power sensors, appliance integrations, printer integrations (progress, ETA, error)                 | P       | L           | 4   | 4   | 16  |
| 10  | **Energy insights & cheap-hour planning**              | "Top 5 consumers this week? When is power cheapest tomorrow for the dishwasher?"                                                     | energy dashboard statistics, dynamic tariff sensors (Zonneplan, Axle and others)                   | R+P     | L           | 4   | 4   | 16  |
| 11  | **Climate comfort advisor**                            | "Heating is on but the bedroom window is open." "Why is the office stuffy?" (CO2)                                                    | climate (read), window sensors, CO2/humidity; suggests changes (climate actions out of scope)      | R+P     | M           | 4   | 4   | 16  |
| 12  | **Presence & "who's home"**                            | "Is anyone home? When did the kids get back?"                                                                                        | person, zone, device_tracker history                                                               | R       | M (privacy) | 4   | 4   | 16  |
| 13  | **Groceries & meal plan**                              | "Plan 5 dinners, build the shopping list, show it in the store."                                                                     | app-local checklist; HA todo read (todo writes would need a new configured scope)                  | R(+A\*) | L           | 4   | 4   | 16  |
| 14  | **Family chores & coordination board**                 | "Weekly chore chart with who-did-what, visible on everyone's phone."                                                                 | app-local checklist/counter, calendar read, HA users                                               | R       | L           | 4   | 4   | 16  |
| 15  | **Security check-in (read-only)**                      | "While I was away, did any door open? Is the alarm armed?" — never unlocks or disarms                                                | lock, alarm_control_panel, binary_sensor, logbook                                                  | R+P     | M–H         | 4   | 4   | 16  |
| 16  | **Weather / air-quality advice**                       | "Should I open windows tonight?" "Pollen high — close the bedroom window."                                                           | weather, outdoor sensors, AQI                                                                      | R+P     | L           | 3   | 5   | 15  |
| 17  | **Travel / away mode prep**                            | "We leave Friday for 5 days: checklist, what to switch off, what to watch."                                                          | checklist app, watchers, light/switch off via Ask                                                  | R+P+A   | M           | 4   | 3   | 12  |
| 18  | **Accessibility companion**                            | Large-text and voice-friendly "what's on in the house," one-tap approved controls for a relative with low vision or limited mobility | same as #2, plus TTS via companion app; large-type component variants                              | R+A     | M           | 4   | 3   | 12  |
| 19  | **Leak / freeze alerting explainer**                   | "The leak sensor fired — where, when, what's the history?" (HA automations stay the primary alarm path)                              | moisture and temperature sensors, logbook                                                          | P       | M–H         | 4   | 3   | 12  |
| 20  | **Plant care board**                                   | "Which plants need water? Show soil moisture over 2 weeks."                                                                          | plant/soil sensors (e.g. the new Willow integration)                                               | R+P     | L           | 3   | 4   | 12  |
| 21  | **Pet care**                                           | "Did the feeder dispense? Litter box visits today? Is it too hot for the dog while we're out?"                                       | feeder, litter and pet-door integrations, temperature                                              | R+P     | L–M         | 3   | 4   | 12  |
| 22  | **Kids' routines**                                     | Bedtime countdown, chore stars, "is my light allowed on?" — kid profile is read-only                                                 | timer/counter/checklist apps; per-user permission profile                                          | R       | L           | 3   | 4   | 12  |
| 23  | **Guest guide**                                        | "Make a guest page: Wi-Fi, how the heating works, which lights they can use."                                                        | note/text app, entity tiles; guest-scoped permissions                                              | R(+A)   | M           | 3   | 4   | 12  |
| 24  | **Setup hygiene & naming advisor**                     | "Which entities have bad names or no area? Suggest a cleanup plan."                                                                  | entity, device and area registries (read); output is a proposal list                               | R       | L           | 3   | 4   | 12  |
| 25  | **Camera event summaries**                             | "What happened at the front door today?"                                                                                             | camera snapshots + vision model; heavy privacy risk; high hallucination risk (see Gemini for Home) | R+P     | H           | 3   | 2   | 6   |

\* Writes to `todo.*`, `notify.*` or `climate.*` are outside today's light/switch Full-access scope. Add them later as explicit, separately configured scopes with **Ask** as the default.

**Evidence that these use cases are real:**

- HA ships a "Daily summary by Assist" blueprint (calendar + weather). [HA docs](https://www.home-assistant.io/voice_control/assist_daily_summary/)
- Users send morning TTS briefings with prompts that say "do not include Home Assistant internal details such as entities." [Reddit](https://www.reddit.com/r/homeassistant/comments/1htascj/tts_morning_briefing_via_ai/)
- LLM vision is used for meters, parking and pet false alarms; families keep using whiteboards for shopping lists. [Reddit](https://www.reddit.com/r/homeassistant/comments/1mwm97d/what_do_you_use_llm_vision_for/)
- Troubleshooting with Claude "would've taken me hours… took Claude minutes." [Android Authority](https://www.androidauthority.com/using-claude-fix-home-assistant-smart-home-3674998/)
- HA hides locks and garage doors from voice by default "to avoid that sensitive devices… can inadvertently be controlled." [HA docs](https://www.home-assistant.io/voice_control/voice_remote_expose_devices/)
- Community guards go further: "voice can lock the front door, never unlock it." [GitHub PR](https://github.com/johnae/world/pull/1795)

**What the ranking implies:** The top 8 are all read-heavy or limited to lights/switches, and they ship with today's permission model. Proactive cases (#1, #5, #6, #9–11) need one new primitive: **controller-side deterministic watchers and schedules**, durable across restarts, that create inbox cards and optionally start a summarizing conversation. They never call services.

---

## 2. Competitive and inspiration scan (2025–2026)

| Product                                 | What works                                                                                                                                                                                                                                                                                                                                                                                                                           | What users complain about                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Lesson for Hearth                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HA Assist + LLM integrations**        | Local-first; Assist handles simple commands before the LLM; shared context; LLM can start conversations; streaming TTS ~10× faster; AI Tasks with JSON output; MCP client and server; OpenRouter. [HA](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant/) Community benchmark: [Home LLM leaderboard](https://github.com/allenporter/home-assistant-datasets/tree/main/reports)                                    | Requests fail when an entity isn't exposed; local models slow; "skip think-mode models" for voice. [Zelpio](https://www.zelpio.com/blog/home-assistant-voice-preview-edition-review/) · [Botmonster](https://botmonster.com/smart-home/build-private-local-ai-voice-assistant-2026/)                                                                                                                                                                                                                                                     | Use a deterministic fast path for known questions (#2, #5) and use the LLM for explanation. Tell users when an entity is out of scope instead of failing silently.                 |
| **HA Voice Preview Edition**            | Private, local, smooth setup                                                                                                                                                                                                                                                                                                                                                                                                         | Wake-word accuracy in noisy rooms, quiet speaker; "anything beyond 'turn the lights on' still needs" an LLM. [Botmonster](https://botmonster.com/smart-home/home-assistant-voice-preview-edition-review/)                                                                                                                                                                                                                                                                                                                                | Hearth is phone-first and text-first. Voice can come later through HA's pipeline.                                                                                                  |
| **Amazon Alexa+**                       | Better natural language; proactive tips (commute, deals); natural-language routines. [Amazon](https://www.aboutamazon.com/news/devices/new-alexa-generative-artificial-intelligence)                                                                                                                                                                                                                                                 | Claims actions it never took; "unpredictable toddler"; buggy, slow app. [WIRED](https://www.wired.com/story/why-is-amazon-alexa-plus-so-bad/) · [CR](https://www.consumerreports.org/electronics/digital-assistants/amazon-alexa-plus-ai-assistant-review-a1667486499/)                                                                                                                                                                                                                                                                  | **Read the state back after every action.** Show "Done ✓ (verified)", "Failed", or "Unknown — check device" with the real final state. Never retry automatically (already a rule). |
| **Google Gemini for Home**              | Natural language; Ask Home searches camera history; "help me create automations." [Google](https://blog.google/products-and-platforms/devices/google-nest/gemini-for-home-launch/)                                                                                                                                                                                                                                                   | Made-up Home Briefs and device states; "insists it did things correctly"; fewer tools than full Gemini; device actions still run through the old Assistant. [Verge](https://www.theverge.com/tech/813523/gemini-for-home-google-nest-camera-hands-on) · [TechRadar](https://www.techradar.com/home/smart-home/think-twice-about-upgrading-to-gemini-for-home-its-getting-some-tasks-absolutely-wrong-and-is-full-of-bugs) · [Reddit](https://www.reddit.com/r/googlehome/comments/1pn6im6/gemini_for_home_isnt_really_gemini_heres_why/) | **Briefings must cite entities and show "as of" times.** Numbers are drawn by the controller. Camera summaries are lowest priority.                                                |
| **Apple Home**                          | Siri-AI home hub and widgets expected Oct 13, 2026. [MacRumors](https://www.macrumors.com/2026/10/01/apple-launch-new-smart-home-devices-this-month/)                                                                                                                                                                                                                                                                                | Long delays; HomeKit "can no longer keep up." [MacRumors](https://www.macrumors.com/2025/11/05/apple-smart-home-hub-2026-rumors/)                                                                                                                                                                                                                                                                                                                                                                                                        | Mainstream users will expect glanceable widgets. Pinned apps should work as widgets.                                                                                               |
| **Homey**                               | Official ChatGPT app and MCP server: control devices, rename, guided Flow creation. [Matter Alpha](https://www.matteralpha.com/news/homey-s-ai-ambitions-could-finally-deliver-the-smart-home-we-were-promised)                                                                                                                                                                                                                      | Security worries about cloud AI reaching home devices (same article)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Ecosystems are putting the home _inside_ ChatGPT/Claude. Hearth puts the AI _inside the home_, behind a permission broker. Make that the pitch.                                    |
| **Claude artifacts / MCP Apps**         | Artifacts have persistent storage (20 MB per artifact, per secondary sources) and MCP access; shareable apps; interactive connectors (Asana, Figma, Slack) in chat. [Anthropic](https://claude.com/blog/build-artifacts) · [Anthropic](https://claude.com/blog/interactive-tools-in-claude) · [Caipi](https://caipi.ai/blog/can-claude-artifacts-save-data)                                                                          | Storage limits; it's code running in a sandbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Copy the _"build an app by chatting, then it persists"_ experience, but with declarative specs instead of code.                                                                    |
| **ChatGPT Apps SDK → MCP Apps**         | One standard across ChatGPT, Claude, VS Code and Goose; UI in a sandboxed iframe; host can require consent for UI-initiated tool calls; auditable JSON-RPC. [MCP blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) · [OpenAI](https://developers.openai.com/apps-sdk/reference)                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Borrow **"auditable messages"** and **"user consent for UI-initiated tool calls."** Don't borrow iframe/JS.                                                                        |
| **ChatGPT Pulse**                       | Overnight async research → morning cards; refine with feedback. [OpenAI](https://openai.com/index/introducing-chatgpt-pulse/)                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Model the "Today" inbox on Pulse cards, but ground them in home data.                                                                                                              |
| **Meta Muse (inspiration only)**        | Personal agent "with your approval"; open-source gadgets; e-ink morning briefing; can link to HA through a Pi 5. [TechMyMoney](https://techmymoney.com/2026/10/02/meta-muse-gadgets-opens-the-ai-agent-to-diy-hardware-with-a-free-home-link-for-us-subscribers/)                                                                                                                                                                    | Business model still unclear. [CNBC](https://www.cnbc.com/2026/10/07/meta-muse-personal-ai-agents-dazzle.html)                                                                                                                                                                                                                                                                                                                                                                                                                           | Briefings fit ambient screens. A later "e-ink / wall tablet" view of pinned apps is a natural extension.                                                                           |
| **Google generative UI (dynamic view)** | Strong rater preference                                                                                                                                                                                                                                                                                                                                                                                                              | Can take a minute or more; inaccuracies. [Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)                                                                                                                                                                                                                                                                                                                                                                  | Small specs, cached apps, incremental patches.                                                                                                                                     |
| **Declarative UI protocols**            | A2UI (flat list, catalog, data model, streaming). [A2UI](https://a2ui.org/introduction/agent-ui-ecosystem/) json-render (Zod catalog, `$state`/`$cond`, actions, generated prompts, devtools). [json-render](https://github.com/vercel-labs/json-render) Adaptive Cards (vertical stacks + ColumnSet; host theming; versioned schema). [Microsoft](https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/getting-started) | Adaptive Cards is limited in expressiveness and needs strict schema versioning (Copilot Studio supports ≤1.6). [Microsoft](https://learn.microsoft.com/en-us/microsoft-copilot-studio/adaptive-cards-overview)                                                                                                                                                                                                                                                                                                                           | Version the spec from day one. Keep the vocabulary small and home-specific. Generate the model's tool description from the catalog.                                                |
| **Community agentic HA dashboards**     | ai_agent_ha: "Create dashboards by chatting." [GitHub](https://github.com/sbenodiz/ai_agent_ha) LLM-written YAML dashboards built iteratively. [DIY Solar](https://diysolarforum.com/threads/using-llms-to-generate-yaml-for-home-assistant.100654/)                                                                                                                                                                                 | Write access to config; LLMs rarely right the first time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Hearth's apps live in Hearth's own store, **never in HA config**. Iterate by patching.                                                                                             |
| **Floor-plan / pixel dashboards**       | Pokémon pixel map, 3D floorplan cards with live markers. [How-To Geek](https://www.howtogeek.com/pokemon-style-home-assistant-dashboard/) · [HA Community](https://community.home-assistant.io/t/floorplan-3d-a-home-assistant-3d-floorplan-card/902878)                                                                                                                                                                             | Hours of manual art and setup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Auto-generate the world. Let art be optional.                                                                                                                                      |

**Net positioning:** _"The home AI that never lies about your house."_ It is durable (conversations survive restarts), shows its sources, verifies outcomes, and builds you small apps that read real values.

---

## 3. "Apps on demand" design

### 3.1 Principles (taken from A2UI, json-render, Adaptive Cards and MCP Apps)

1. **Catalog-constrained.** The model can only use the component types and props in Hearth's catalog. Anything else fails validation with a model-readable error ([json-render](https://github.com/vercel-labs/json-render/blob/main/README.md)).
2. **Flat element map with ID references.** Easy to stream, patch and repair ([A2UI](https://a2ui.org/introduction/what-is-a2ui/)).
3. **Structure, data and rendering stay separate.** The model writes _structure and bindings_. **The controller resolves every HA value.** Literal numbers or states for entity-bound props are rejected.
4. **No code, no HTML, no URLs that run anything.** Text is plain or a strict markdown subset (no raw HTML, no images, no `javascript:` links; links limited to internal HA routes or nothing).
5. **Actions are named references, not callbacks.** Every interaction maps to a small fixed set of action kinds. Home actions go through the existing Home permissions broker at _press time_.
6. **Versioned from day one** (`specVersion`), as Adaptive Cards shows is necessary.
7. **Generate the tool description from the catalog,** like json-render's `catalog.prompt()`, so the model's instructions never drift from the validator.

### 3.2 Spec shape (Hearth App Spec v1, "HAS/1")

```json
{
  "specVersion": "has/1",
  "id": "app_laundry",
  "title": "Laundry",
  "icon": "mdi:washing-machine",
  "summary": "Washer/dryer status, finish alerts, and a folding checklist",
  "scope": {
    "entities": [
      "sensor.washer_power",
      "sensor.washer_state",
      "sensor.dryer_state",
      "switch.dryer_plug"
    ]
  },
  "root": "main",
  "elements": {
    "main": { "type": "Stack", "children": ["status", "chart", "todo"] },
    "status": {
      "type": "Grid",
      "props": { "columns": 2 },
      "children": ["washer", "dryer"]
    },
    "washer": {
      "type": "EntityTile",
      "props": { "entity": "sensor.washer_state", "label": "Washer" }
    },
    "dryer": {
      "type": "EntityTile",
      "props": { "entity": "sensor.dryer_state", "label": "Dryer" },
      "visibleWhen": {
        "entity": "sensor.dryer_state",
        "op": "neq",
        "value": "unavailable"
      }
    },
    "chart": {
      "type": "HistoryChart",
      "props": {
        "entities": ["sensor.washer_power"],
        "hours": 6,
        "kind": "line"
      }
    },
    "todo": {
      "type": "Checklist",
      "props": { "stateKey": "fold", "items": ["Towels", "Kids' clothes"] }
    }
  },
  "watchers": [
    {
      "id": "washer_done",
      "when": {
        "entity": "sensor.washer_state",
        "to": "idle",
        "from": "running"
      },
      "card": {
        "title": "Washer finished",
        "body": "Move laundry to the dryer."
      },
      "repeatAfterMinutes": 30,
      "maxRepeats": 2
    }
  ]
}
```

- `scope.entities` is a declared allowlist. Every binding must be in it **and** inside Hearth's configured read scope. Adding entities is visible in the diff.
- App-local state (checklist ticks, counters, notes) is stored **separately** from the spec. Spec upgrades never wipe user data.
- `watchers` are deterministic and controller-evaluated. They create inbox cards and can optionally wake a conversation to summarize. They never call services.

### 3.3 Component vocabulary (v1 ≈ 22 components)

Safety classes: **D** = display only · **L** = writes app-local state only · **H** = Home action, routed through the permissions broker · **M** = hands a draft to the model, which the user must send.

| Component                            | Key props                                                       | Data source                               | Class                | Safety notes                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------- | ----------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stack / Grid / Tabs / Section / Card | children, columns(1–3), title                                   | —                                         | D                    | Depth ≤ 6, ≤ 80 elements, ≤ 8 tabs                                                                                                                                                              |
| Text                                 | text, variant(h1/h2/body/caption)                               | literal or `$template` of resolved values | D                    | Plain text or strict markdown subset; no HTML or images                                                                                                                                         |
| EntityValue                          | entity, attribute?, format, unit?                               | controller                                | D                    | Value never comes from the model; shows "as of" on long-press                                                                                                                                   |
| EntityTile                           | entity, label?, icon?                                           | controller                                | D (+H if toggleable) | Tap opens a details sheet; toggling is a separate ToggleAction                                                                                                                                  |
| StatusPill / Badge                   | entity, okStates[] / thresholds                                 | controller                                | D                    | Color always paired with icon and text                                                                                                                                                          |
| Gauge                                | entity, min, max, bands                                         | controller                                | D                    | —                                                                                                                                                                                               |
| HistoryChart                         | entities[≤4], hours(≤168) or days(≤31), kind(line/bar/timeline) | recorder history                          | D                    | Down-sampled server-side; rate-limited                                                                                                                                                          |
| StatisticsChart                      | entity, period(hour/day/week/month), stat(mean/sum/max)         | long-term statistics                      | D                    | Good for energy                                                                                                                                                                                 |
| Logbook                              | entities[], hours                                               | logbook                                   | D                    | Entity names treated as untrusted text                                                                                                                                                          |
| Agenda                               | calendar entities[], days(≤14)                                  | calendar read                             | D                    | Event text is untrusted; never fed to actions                                                                                                                                                   |
| Weather                              | weather entity                                                  | controller                                | D                    | —                                                                                                                                                                                               |
| Presence                             | person entities[]                                               | controller                                | D                    | Privacy: hidden from guest/kid profiles unless allowed                                                                                                                                          |
| Checklist                            | stateKey, items[], allowAdd                                     | app-local                                 | L                    | Items typed by family are untrusted when read back by the model                                                                                                                                 |
| Counter                              | stateKey, step, min/max, resetSchedule                          | app-local                                 | L                    | —                                                                                                                                                                                               |
| Timer / Countdown                    | stateKey, durations[], target?                                  | app-local + controller clock              | L                    | Runs on the controller so it survives restarts and phone sleep                                                                                                                                  |
| Note                                 | stateKey, maxLength(≤4k)                                        | app-local                                 | L                    | Untrusted when read by the model                                                                                                                                                                |
| Reminder / Schedule                  | rrule-lite (daily/weekly/every N days), message                 | controller scheduler → inbox              | L                    | Delivered in the Hearth inbox; HA `notify` only if a notify scope is configured                                                                                                                 |
| ToggleAction                         | entity (light/switch), label                                    | broker                                    | **H**                | Read-only → disabled with explanation; Ask → exact approval card (entity, service, data); Full → only configured scopes; outcome verified by reading state back; unknown → shown, never retried |
| SceneButton                          | name, calls[] (each light/switch service with data)             | broker                                    | **H**                | Each call is checked against scope at save time **and** press time; the approval card lists every call                                                                                          |
| AskButton                            | label, promptTemplate                                           | —                                         | **M**                | Opens the conversation with a prefilled, editable draft; nothing is sent until the user taps Send                                                                                               |
| Form                                 | fields (text/number/select/date), submit = AskButton            | —                                         | **M**                | Turns form input into a visible draft message (A2UI's "form instead of 20 questions")                                                                                                           |
| OpenApp / OpenConversation           | appId / conversationId                                          | —                                         | D                    | Internal navigation only                                                                                                                                                                        |

**Explicitly excluded from v1:** raw images or URLs, camera streams (later: controller-proxied snapshot with a privacy toggle), iframes, custom CSS, arbitrary expressions, network fetches, and any service outside the configured scopes.

**Condition language (`visibleWhen`, `$cond`):** `{entity|stateKey, op: eq|neq|gt|lt|gte|lte|in, value}`, combined with `all`/`any`. It is not Turing-complete and is evaluated by trusted code.

### 3.4 Pi tools (controller-side; all validated)

- `app_create(spec)` → `{ok, appId, version, warnings[]}` or `{ok:false, errors:[{path, message, hint}]}`. Errors are written so the model can repair the spec in one turn.
- `app_update(appId, baseVersion, patch)` → JSON Patch ([RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902)) against the spec. Optimistic concurrency: a stale `baseVersion` is rejected and the current version returned.
- `app_list()`, `app_get(appId, version?)`, `app_read_state(appId)`. State is returned **wrapped as untrusted user content**.
- `catalog_describe()`, generated from the same schema the validator uses.
- **No tool lets the model press a button, tick a checklist, or run a SceneButton.** Only humans interact with app controls.

### 3.5 Validation pipeline (controller)

1. JSON Schema / Zod parse → 2. catalog check (types, props, enums) → 3. graph check (root exists, no cycles, no orphans, limits) → 4. **binding check**: entities exist, are in `scope.entities`, and are in Hearth's read scope; entity-bound props contain no literal values → 5. **action check**: every H-class call maps to an exact configured scope (domain, service, entity, allowed data keys) → 6. text sanitization and length limits → 7. lint warnings (e.g. "chart over 4 entities is hard to read on a phone") → 8. render a preview card in chat with **Save / Pin / Discard**.

- Unknown component at render time (e.g. after a downgrade) → shows an "Unsupported block" placeholder; the app never crashes.
- Missing entity at runtime → tile shows "Unavailable (entity removed)" and the app is flagged "needs repair" in the drawer.

### 3.6 Storage, versioning, sharing

- `/data/hearth/apps/<appId>/spec.v<N>.json`: append-only, immutable versions, plus `meta.json` (title, owner user, created-by conversation ID, model/provider label without credentials, parent version, change summary, pinned flag) and `state.json` (app-local data, with its own migrations).
- Apps are **household objects, not tied to a conversation.** Any conversation can reference `appId`. "Ask to change" attaches the current version to the conversation context.
- Version history: list, preview old version, **Revert** (creates version N+1 = copy of K), **Duplicate**, **Export JSON** (for sharing with other Hearth users; import goes through full validation and **drops all H-class components until the importer re-confirms them against their own scopes**).
- Per-user visibility: private / household / guest-visible. Kid and guest profiles can only see apps marked for them.

### 3.7 User editing and pinning UX (mobile)

- **Apps drawer** (tab bar): grid of app cards with live mini-status.
- **Long-press an app** → Pin to Home canvas · Rename · Reorder blocks (drag, no model) · Hide block · Ask to change… · History · Duplicate · Export · Delete.
- **"Ask to change"** → conversation opens with the app attached → model emits a patch → **diff card** ("+1 chart, −1 tile, entities added: sensor.dryer_power") → Accept / Reject / Try it (applies a temporary version, auto-reverts if not kept).
- **Home canvas** = pinned apps plus assistant-arranged layout. Users can lock layout so the assistant can't rearrange it.

### 3.8 Ten example apps

1. **Laundry & dishes** — EntityTiles, power HistoryChart, Checklist, watcher "finished" + "still wet after 30 min".
2. **Bedtime lock-up** — StatusPills for doors/windows/garage/locks (read-only), list of lights on, SceneButton "All downstairs lights off" (H, Ask).
3. **Energy today** — StatisticsChart (daily kWh), tariff HistoryChart with cheapest window highlighted, AskButton "Plan my appliances for tomorrow".
4. **Groceries & meal plan** — Tabs (Plan / List), Checklist with allowAdd, Form "dietary needs this week" → AskButton.
5. **Kids' chore chart** — Counter per child (stars), Checklist reset every Sunday, Timer "bedtime in 20 min"; visible to the kid profile.
6. **Plant care** — Gauge per soil sensor, 14-day HistoryChart, Reminder "fertilize every 30 days", watcher "moisture < 20%".
7. **Pet sitter guide** (guest-visible) — Text instructions, Presence hidden, EntityValue for feeder and water fountain, ToggleAction for the hallway light only.
8. **3D print monitor** — EntityValues (progress, ETA, nozzle/bed temperature), state Logbook, watcher "error/paused", AskButton "Why might this print have failed?"
9. **Away / travel mode** — Checklist (pre-departure), StatusPills (doors, leak sensors, freezer temperature), watchers for leak/freezer/door-open-while-away, SceneButton "Away lights off".
10. **Maintenance log** — Reminders (HVAC filter 90 days, smoke alarm test monthly, descale kettle), Note log, Logbook of battery-low events, device-health StatusPills.

---

## 4. "Self-improving" design within the constraints

### 4.1 Four levels (each is a proposal; nothing is applied without the owner)

| Level                              | What changes                                                                                   | Who drafts                                                                         | Who approves                | How it is applied                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| L0 Feedback                        | nothing (signals only)                                                                         | user / controller                                                                  | —                           | stored locally                                                                                  |
| L1 Preferences & memory            | memory entries (e.g. "Kitchen means light.kitchen_ceiling + light.kitchen_strip")              | model in a no-tools reflection turn                                                | owner tap                   | versioned memory store, revertible                                                              |
| L2 Prompts, apps, canvas, watchers | household instructions/persona text, app specs (JSON Patch), canvas layout, watcher thresholds | model                                                                              | owner tap on diff           | new version, revertible; optional "try for 7 days"                                              |
| L3 Code                            | Hearth Pi source                                                                               | **offline Code worker** (non-root, confined, no HA token, no provider credentials) | owner reviews patch + tests | owner downloads patch → normal dev/release → reinstall add-on. **Hearth never deploys itself.** |

**Hard limits for proposals:**

- No proposal may widen permissions, add service scopes, switch to Full access, add entities to the global read scope, or edit security rules or settings. The assistant may _suggest_ these in text, with a link to the settings page.
- Proposals that touch security-sensitive areas (scopes, approval flow, credentials, sandbox config, CSP, sanitizer) are labelled **"Security review required"** and can't be accepted with one tap. L3 only.

### 4.2 Feedback capture (L0)

- **Explicit:** 👍/👎 on every assistant turn and every proactive card. 👎 opens reason chips: _wrong value · wrong device · didn't do it · too long · not useful · creepy/privacy_, plus an optional note.
- **Implicit (local counters only):** app opens, pins/unpins, blocks hidden, approval accepted/denied/expired, unknown-outcome events, tool errors by tool name, validation failures by error code, card dismissals, "Ask to change" frequency per app.
- **Store:** SQLite in `/data/hearth/analytics.db`. Events hold IDs, counts and error codes — **no prompt or response text by default**. 90-day retention. "Insights" page; **Export** and **Delete all**. Nothing leaves the device; there is no telemetry endpoint.

### 4.3 Proposal engine (L1/L2)

- **Trigger:** a weekly controller job (durable schedule), or a threshold such as ≥3 👎 with the same reason on the same app or entity, or ≥2 denied approvals for the same action pattern.
- The controller builds an **aggregate evidence pack** (counts, error codes, the specific spec version and memory entries involved) and runs a **reflection conversation with no tools except `propose_*`**. Output is limited to 3 proposals per run.
- **Proposal object:** `{id, kind: memory|instructions|app|canvas|watcher|code, title, rationale, evidence[], diff, risk: low|med|security, expiresAt}`.
- Proposals are validated by the same pipelines as direct edits (e.g. app proposals pass the full HAS/1 validator).
- **Inbox → "Suggestions" tab:** Accept · Edit then accept · Reject (optional reason) · Snooze. **Rejections are stored and fed back** so the same idea isn't proposed again for 60 days. SkillOpt: "rejected updates are still useful."
- **Approval = a controller-recorded UI event** tied to the logged-in HA user and proposal hash. It is never a model-set flag (contrast BerriAI's `userConfirmedInThisMessage`).
- Every accepted change creates a version with **one-tap Revert**. "Try for 7 days" adds an automatic reminder: _Keep / Revert_.

### 4.4 Code-level improvements (L3) — UX flow

1. A proposal of kind `code`, or the owner's own request ("the chart is unreadable on my phone; fix it"), appears with **"Draft in Code session."**
2. The controller creates a Code session with a **task brief**: problem statement, evidence counts, relevant error codes, and optional owner-approved fixtures that are _scrubbed_ (entity names replaced). No secrets, no HA token, no network.
3. The worker (offline, non-root, confined workspace copy of the repo) produces a **patch + test run log + summary + risk notes**.
4. **Review screen (mobile):** files changed, a diff viewer with collapsible hunks, test results, and the assistant's "what could break." Any touched paths matching the security-sensitive list are flagged red.
5. The owner chooses **Download patch / Copy / Discard / Ask for changes** (another worker round). **There is no "Apply to running Hearth" button.** Applying happens outside Hearth through a normal commit, CI and release, and the add-on updates through the Supervisor like any other update.
6. After release, the proposal is marked "shipped in vX.Y," and the next weekly job checks whether the target metric (e.g. 👎 on that chart) improved.

### 4.5 Three concrete flows

- **Wrong device → memory (L1):** User: "Turn on the kitchen lights." Model asks for approval for `light.kitchen_ceiling`; the user wanted both strips. User 👎 "wrong device". Card: _"Remember: 'kitchen lights' = ceiling + strip?"_ [Accept]. Memory v12 is saved, and the next request produces one approval card with 2 calls.
- **App friction → app patch (L2):** Analytics show the user hides the Laundry chart 4 times and opens the app around 7 pm. Proposal: _"Replace the chart with 'Time remaining' and move the checklist to the top"_ with a diff. User taps **Try 7 days** and later **Keep**.
- **Repeated tool failure → code (L3):** `history_query` times out on 31-day ranges (error code counted 9× this week). Proposal kind `code`: "Down-sample server-side in 1-hour buckets for ranges over 7 days." User taps **Draft in Code session**, the worker delivers a patch plus a unit test, and the owner downloads and releases it.

---

## 5. Home World / think-mode UX

Some points here rest on cited evidence; others are design judgment, labelled _(inference)_.

### 5.1 Make it useful, not just cute

- **Status monitor first.** The Pokémon floor plan succeeds because it mirrors real state instantly, makes lights that are on obvious in its night view, and _is_ a remote (tap to toggle, long-press for more). [How-To Geek](https://www.howtogeek.com/pokemon-style-home-assistant-dashboard/)
- **Exceptions draw attention.** Calm by default. Only anomalies get a glint or speech bubble: window open + heating on, light on in an empty room, device unavailable, leak, appliance done. One tap opens the explanation card _(inference; consistent with HA's 2026.10 "show a card only when it matters" direction, [HA](https://www.home-assistant.io/blog/2026/10/07/release-202610/))_.
- **Think mode shows real tool activity.** When the model reads sensors in an area, the avatar walks to that room with the caption "Reading kitchen sensors (3)…" driven by actual tool-call events, never fake animation. This builds trust and explains latency, which matters because generation can be slow ([Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)).
- **Approvals are never world-only.** An action request appears as the same exact approval card used in chat (entity, service, data) over the world. After execution the avatar shows ✓ verified, ✗ failed, or ? unknown, matching the read-back state.
- **Day/night follows `sun.sun`** and the real clock, like the night view in the Pokémon dashboard and Animal Crossing's real-time rhythm _(inference)_. Avoid Tamagotchi-style guilt loops or streaks: no "your home is sad" mechanics _(inference)_.

### 5.2 Customization pattern (zero-effort default, deep optional)

1. **Auto-layout** from the HA floor and area registries: each floor is a level and each area a room tile sized by entity count. Devices are placed by domain/device class with default sprites (bulb, plug, thermostat, washer, printer, plant, pet bowl).
2. **Drag to arrange** rooms and devices; snap to a grid. No drawing tools.
3. **Theme packs**: pixel 16-bit (default), flat/minimal (accessibility and performance), opt-in 3D. Owner-supplied sprites are allowed only as static images (PNG/WebP) uploaded through the UI and served by the controller, never model-generated markup.
4. **The assistant may propose world layouts** as an L2 proposal (declarative JSON: rooms, positions, sprite IDs), validated like apps.

### 5.3 Accessibility

- **List-view parity:** every world element has an equivalent in an accessible DOM list (room → devices → state). The canvas is `aria-hidden`, and focus moves through real buttons.
- Respect `prefers-reduced-motion` (static world, no walking avatar, instant transitions) and system text size. Tap targets ≥ 44 px. Never use color alone (icon + label + pattern for state). High-contrast theme.
- Announce state changes politely (`aria-live="polite"`) only for anomalies, not every sensor tick.

### 5.4 Phone performance (HA companion app WebView)

- Use Canvas 2D or SVG for pixel art at integer scaling with `image-rendering: pixelated`. Start simple and measure ([SVG Genie](https://www.svggenie.com/blog/svg-vs-canvas-vs-webgl-performance-2025)). Use WebGL/3D only when chosen, with `alpha:false` and capped `devicePixelRatio` ([MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices) · [Three.js discourse](https://discourse.threejs.org/t/animate-low-performance-on-mobile-with-window-devicepixelratio-resize/23628)). Use adaptive quality, e.g. drei `PerformanceMonitor` ([Utsubo](https://www.utsubo.com/blog/threejs-best-practices-100-tips)).
- **Render on change, not every frame:** redraw only when a state-change event arrives or an animation is running. Cap animation at 30 fps. Pause on `visibilitychange`. Use sprite atlases. Subscribe only to visible areas' entities.
- Budget targets: first paint < 1 s on a mid-range Android, idle CPU ≈ 0%, JS bundle for the world < 150 KB gzipped (2D theme) _(inference — targets, not measured)_.

---

## 6. Prioritized roadmap — 3 iterations (each ≈ 1 day of agent work)

### Iteration 1 — "Apps v0: declarative mini-apps that read real values"

**Scope:**

- HAS/1 schema plus validator, starting with 12 components: Stack, Grid, Tabs, Card, Text, EntityValue, EntityTile, StatusPill, HistoryChart, Checklist, Counter, Note, ToggleAction.
- Tools: `app_create`, `app_update` (JSON Patch + baseVersion), `app_get`, `app_list`, `catalog_describe` (generated from the schema).
- Trusted renderer; versioned store under `/data/hearth/apps`; Apps drawer; pin to Home canvas; diff card for updates; 3 built-in templates (Bedtime lock-up, Laundry, Energy today).

**Acceptance criteria:**

- [ ] Unknown component or prop, cycles, or over-limit specs are rejected with path-specific errors. At least 30 validator unit tests.
- [ ] A spec with a literal value in an entity-bound prop is rejected. Every rendered value comes from controller state, shown with an "as of" timestamp.
- [ ] Entities outside `scope.entities` or Hearth's read scope are rejected.
- [ ] ToggleAction: Read-only → disabled with explanation. Ask → approval card with exact domain/service/entity/data. Full → executes only for configured light/switch scopes. Outcome read back; "unknown" shown and never auto-retried.
- [ ] No HTML/JS paths: sanitizer tests (script tags, `javascript:` links, event-handler attributes) and a CSP header test.
- [ ] Apps, versions and app-local state survive add-on restart. Revert creates a new version. Concurrent stale update returns a conflict.
- [ ] Renders correctly at 360 px width in the companion app. The model can create a working app from "make me a laundry app" in ≤ 2 tool calls on a mainstream model.

### Iteration 2 — "Briefings, watchers, feedback, and the Suggestions inbox"

**Scope:**

- Durable controller-side scheduler and deterministic watchers (state transition, threshold, duration, schedule), plus a "Today" inbox of cards.
- Morning/evening briefing (watcher-triggered conversation in a summarize-only, read-only tool profile, rendered as a card whose numbers are controller-bound).
- Reminder and Timer components.
- 👍/👎 + reason chips; local analytics SQLite; Insights page with export/delete.
- Suggestions inbox for L1 memory and L2 app/instruction proposals with Accept / Edit / Reject / Snooze / Revert, and a rejection memory.

**Acceptance criteria:**

- [ ] Watchers and schedules survive restarts. Missed schedules during downtime run once, marked "late," with no duplicates.
- [ ] Watchers have no code path to call services (static test plus unit test).
- [ ] Every number in the briefing card is a binding resolved by the controller. Removing an entity shows "unavailable," not a guess.
- [ ] Analytics rows contain no prompt or response text by default (schema test). "Delete all" empties the DB.
- [ ] Proposals pass the same validators. Approval is recorded as a UI event with user ID and proposal hash. Proposals that widen permissions are impossible: the schema has no such kind, with a test.
- [ ] A rejected proposal is not re-proposed within 60 days (test with a fixed clock).

### Iteration 3 — "Home World v1 + Code-session improvement loop"

**Scope:**

- Auto-generated 2D pixel world from floors/areas; live state glints for anomalies; tap/long-press parity with EntityTile.
- Think-mode avatar driven by real tool-call events (area mapping); approval overlay identical to chat.
- List-view parity; reduced-motion; flat theme.
- "Draft in Code session" from a code proposal → patch + tests + summary → mobile diff review → download only; security-path flagging.

**Acceptance criteria:**

- [ ] The world builds with zero configuration for any HA instance with areas. Entities without areas go to an "Unassigned" shed.
- [ ] Idle CPU ≈ 0 (no animation frames while idle); rendering pauses when hidden; 30 fps cap; DPR ≤ 2.
- [ ] Screen-reader walkthrough reaches every device via the DOM list. `prefers-reduced-motion` disables walking and transitions.
- [ ] Avatar movement only occurs in response to logged tool events (test with a mocked event stream).
- [ ] Code sessions get no HA token, provider credentials or network (checked via environment and config test). Output is a patch artifact. There is no API to apply a patch to the running controller. Diffs touching the security-sensitive paths list are labelled "Security review required."

**Why this order:** Iteration 1 unlocks 7 of the top 8 use cases and the "Swiss army knife" demo. Iteration 2 adds the proactive cases and starts the improvement flywheel safely. Iteration 3 adds the delight layer and closes the loop for code improvements once there is real usage data to improve against.

---

## Sources

**Kept:**

- HA blog "Building the AI-powered local smart home" (https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant/) — primary source on HA's AI architecture, AI Tasks, MCP, conversation starting.
- HA 2025.8 and 2026.10 release notes (https://www.home-assistant.io/blog/2025/08/06/release-20258/, https://www.home-assistant.io/blog/2026/10/07/release-202610/) — AI Tasks; one-click MCP; conditional cards; new plant/energy integrations.
- HA docs on exposing entities and the daily summary (https://www.home-assistant.io/voice_control/voice_remote_expose_devices/, https://www.home-assistant.io/voice_control/assist_daily_summary/) — safety defaults; briefing precedent.
- A2UI docs (https://a2ui.org/introduction/what-is-a2ui/, https://a2ui.org/introduction/agent-ui-ecosystem/) — declarative UI protocol design and comparison with MCP Apps and AG-UI.
- vercel-labs/json-render README (https://github.com/vercel-labs/json-render) — catalog, Zod validation, bindings, actions.
- MCP Apps announcement (https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/) — iframe security model, consent for UI tool calls.
- Claude blogs (https://claude.com/blog/build-artifacts, https://claude.com/blog/interactive-tools-in-claude) — artifacts with storage; interactive connectors.
- Google Research generative UI (https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/) — preference vs latency and inaccuracy.
- WIRED, Consumer Reports, The Verge, SlashGear, TechRadar, Wirecutter (snippet) — Alexa+ and Gemini for Home failure modes.
- How-To Geek Pokémon dashboard (https://www.howtogeek.com/pokemon-style-home-assistant-dashboard/) — living-map usefulness patterns.
- TechMyMoney on Meta Muse Gadgets (https://techmymoney.com/2026/10/02/...) — Muse home link and briefing display.
- OpenAI Pulse (https://openai.com/index/introducing-chatgpt-pulse/) — proactive card pattern.
- BerriAI self-improving-agent (https://github.com/BerriAI/self-improving-agent) and SkillOpt (https://arxiv.org/pdf/2605.23904) — proposal/approval loops and their weak points.
- PromptShield Home (https://arxiv.org/html/2608.05495), OWASP LLM01 — ambient prompt-injection risk.
- Matter Alpha on Homey + ChatGPT; MacRumors on Apple's Oct 13, 2026 event — competitive context.
- Reddit r/homeassistant threads, Android Authority, How-To Geek on Claude + HA — real usage and sentiment.
- MDN WebGL best practices; Three.js discourse; Utsubo tips — phone performance.

**Dropped:**

- SEO roundups ("Best Home Assistant 2026," 3Zebras, roipad, uprisera, o-mega, explainx) — secondary and repetitive; used at most as corroboration.
- Adaptive Cards Medium posts — Microsoft docs are enough.
- Game-UI case studies (Animal Crossing redesign posts, Game UI Database) — not authoritative for this question; game lessons are labelled as inference.
- Wirecutter full text — HTTP 403; only the search snippet was used.

## Gaps

- **The Nintendo 3DS smart-home assistant demo** couldn't be found as a primary source. Searches only found homebrew 3DS HA dashboards (hass-3ds, HomePad). Ask the owner for the link so the Home World design can borrow its specific interaction patterns.
- **The Home World performance targets** (bundle size, first paint) are reasoned estimates. Measure them on a real mid-range Android companion-app WebView in Iteration 3.
- **Game-design lessons** (calm notifications, no guilt loops) are design judgment, not sourced research. A short usability test with 3–5 household members would validate them.
- **Mainstream-model reliability for HAS/1 generation** is untested. Run a small eval (20 app prompts × 3 providers, including a local OpenAI-compatible model) and check validator pass rate in ≤2 attempts.
- **Expanding scopes to `todo`, `notify` and `climate`** is needed for #11, #13 and #17 to reach full value. That is a product and security decision for the owner, not something to decide by research.
- **Muse's actual HA integration depth** and **Apple's Oct 13 announcement** were not yet verifiable in detail. Recheck after the event.
