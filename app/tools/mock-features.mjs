/**
 * Mock routes + fixtures for docs/features: pages, standing orders, Today
 * (/agenda), ideas, the front desk (coordinator thread) and debriefs. Kept
 * apart from mock-orchestrator.mjs so the base mock stays readable; it is
 * wired in with one call (installFeatures) and one route hook (handle).
 */

const fence = (lang, body) => "```" + lang + "\n" + JSON.stringify(body) + "\n```";
const ymd = (d) => new Intl.DateTimeFormat("en-CA").format(d); // local, like the app
const addDays = (n) => ymd(new Date(Date.now() + n * 86_400_000));
const atToday = (hhmm) => new Date(`${ymd(new Date())}T${hhmm}:00+02:00`).toISOString();

export function installFeatures({ messages, cards, interns, emit, iso }) {
  const now = new Date().toISOString();
  const pages = new Map();
  const page = (p) => {
    const full = { thread_key: p.intern, summary: "", version: 1, pinned: false, created_at: iso(86400e3 * 3), updated_at: iso(3600e3), archived_at: null, ...p };
    pages.set(full.id, full);
    return full;
  };

  page({
    id: "pg_people", intern: "milo", kind: "people", title: "My people", summary: "7 people · 2 follow-ups due", version: 4, updated_at: iso(2 * 3600e3),
    data: {
      people: [
        { id: "p1", name: "Ada Okafor", company: "Willowbrook Vet", email: "ada@willowbrook-vet.example", tags: ["lead", "side"], how_met: "Inbound via the ClinicFlow site", stage: "meeting", last_touch: addDays(-3), next_follow_up: addDays(-1), notes: "Single-vet practice. Asked whether LabLink integration is on the roadmap.",
          timeline: [{ ts: iso(3 * 86400e3), kind: "mail", text: "Asked about pricing for a single-vet practice" }, { ts: iso(86400e3), kind: "meeting", text: "Demo — went well, wants a proposal" }] },
        { id: "p2", name: "Danny Reyes", company: "Kettle Labs", tags: ["lead", "expo:mining-week"], how_met: "Mining Week expo stand", last_touch: addDays(-9), next_follow_up: addDays(0) },
        { id: "p3", name: "Ridgeway Electrical contact", company: "Ridgeway Electrical", tags: ["lead", "expo:mining-week"], how_met: "Mining Week expo", next_follow_up: addDays(4) },
        { id: "p4", name: "Maya", company: "Brightline", tags: ["prospect"], next_follow_up: addDays(12), notes: "Rolled to October." },
        { id: "p5", name: "Greg", company: "Marsh Dental", tags: ["client"], last_touch: addDays(-14) },
        { id: "p6", name: "Noah", company: "Harbor & Co", tags: ["client"], last_touch: addDays(-2), next_follow_up: addDays(6) },
        { id: "p7", name: "Jo", company: "Side Project prospect", tags: ["prospect", "side"], last_touch: addDays(-30) },
      ],
    },
  });
  page({
    id: "pg_pipeline", intern: "milo", kind: "board", title: "Pipeline", summary: "5 leads · 1 signed this month", version: 2,
    data: {
      columns: [{ id: "new", title: "New" }, { id: "contacted", title: "Contacted" }, { id: "meeting", title: "Meeting" }, { id: "signed", title: "Signed" }],
      items: [
        { id: "b1", column: "signed", title: "Willowbrook Vet", subtitle: "Ada · ClinicFlow", person_id: "p1" },
        { id: "b2", column: "contacted", title: "Kettle Labs", subtitle: "Danny · Mining Week lead", due: addDays(0), person_id: "p2" },
        { id: "b3", column: "new", title: "Ridgeway Electrical", subtitle: "Mining Week lead", due: addDays(4) },
        { id: "b4", column: "meeting", title: "Brightline", subtitle: "Maya", due: addDays(12) },
        { id: "b5", column: "new", title: "Side Project — Jo", subtitle: "Cold since August" },
      ],
    },
  });
  // A moodboard (orchestrator pagemedia.ts): images as SVG gradients standing in for photos.
  const swatch = (a, b, label) =>
    "data:image/svg+xml;base64," +
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="400" height="500" fill="url(#g)"/><text x="24" y="470" font-family="sans-serif" font-size="28" fill="white" opacity="0.85">${label}</text></svg>`).toString("base64");
  page({
    id: "pg_refs", intern: "milo", kind: "moodboard", title: "References — reels you sent", summary: "6 references · diving, travel, watches", version: 2,
    data: {
      items: [
        { id: "r1", url: "https://www.instagram.com/reel/demo1/", title: "oceanholic", source: "Ocean Diver", note: "Definition-style caption over footage, no voiceover. Works with a GoPro and no editing.", tags: ["diving"], image: "media:r1.jpg", image_url: swatch("#0b3d6b", "#1fa2c9", "oceanholic") },
        { id: "r2", url: "https://www.instagram.com/p/demo2/", title: "Field watch on the trail", source: "Northwind Outfitters", note: "Wrist shot in hard light; the watch is the anchor, the place is the story.", tags: ["watches"], image: "media:r2.jpg", image_url: swatch("#3b3a2e", "#b08d57", "field watch") },
        { id: "r3", url: "https://www.instagram.com/reel/demo3/", title: "Coastline, one song", source: "A Couple of Journeys", note: "Local-pride travel reel. Take the cut, not the voice.", tags: ["travel"], image: "media:r3.jpg", image_url: swatch("#e07a5f", "#3d405b", "coastline") },
        { id: "r4", title: "Desk at golden hour", note: "Pasted from your photos.", by: "owner", tags: [], image: "media:r4.jpg", image_url: swatch("#f2cc8f", "#81b29a", "desk") },
        { id: "r5", url: "https://www.instagram.com/p/demo5/", title: "peak.", source: "Office Ping Pong", note: "One word doing all the work.", tags: ["humour"], image: "media:r5.jpg", image_url: swatch("#22223b", "#9a8c98", "peak.") },
        { id: "r6", url: "https://example.com/article", title: "How to shoot underwater with a GoPro", source: "example.com", tags: ["diving"], preview: "none" },
      ],
    },
  });
  page({
    id: "pg_events", intern: "nia", kind: "table", title: "Events, Oct–Dec", summary: "6 events · 1 you said yes to", version: 3,
    data: {
      columns: [{ key: "icon", title: "", icon: true }, { key: "name", title: "Event" }, { key: "when", title: "When" }, { key: "where", title: "Where" }, { key: "cost", title: "Cost" }, { key: "why", title: "What it's for" }],
      rows: [
        { id: "e1", icon: "⭐", name: "AI Expo Africa", when: "22–24 Oct", where: "Cape Town", cost: "R2 900", why: "You said yes — AI vendors, good for agency leads" },
        { id: "e2", icon: "🛠", name: "Africa Tech Week", when: "4–6 Nov", where: "Cape Town", cost: "R4 500", why: "Broad tech; skip unless speaking" },
        { id: "e3", icon: "🐄", name: "Vet Congress", when: "12 Nov", where: "Durban", cost: "R1 800", why: "ClinicFlow prospects in one room" },
        { id: "e4", icon: "⛏", name: "Mining Indaba Dinner", when: "28 Nov", where: "Johannesburg", cost: "Invite", why: "Follow-up with Mining Week contacts" },
        { id: "e5", icon: "💡", name: "Open Innovation Summit", when: "3 Dec", where: "Online", cost: "Free", why: "Cheap, watch the IoT track" },
        { id: "e6", icon: "🎤", name: "DevConf Pretoria", when: "10 Dec", where: "Pretoria", cost: "R950", why: "Hiring + talks" },
      ],
    },
  });
  page({
    id: "pg_draft", intern: "milo", kind: "draft", title: "RE: ClinicFlow for Willowbrook Vet", summary: "Reply-all draft · 2 recipients", version: 2, updated_at: iso(20 * 60e3),
    data: {
      draft_id: "AAMkDraft1", mailbox: "side", kind: "reply_all", intended_reply: true,
      to: ["ada@willowbrook-vet.example"], cc: ["lena@sideproject.example"], subject: "RE: ClinicFlow for Willowbrook Vet",
      body: "Hi Ada,\n\nThanks for your time yesterday — great to hear you'd like to go ahead.\n\nI'll send the onboarding pack this afternoon. On LabLink: it's on our roadmap for Q1; I'll keep you posted.\n\nKind regards,\nSam",
      thread: [
        { from: "ada@willowbrook-vet.example", date: iso(86400e3), preview: "Hi Sam, thanks for the demo — we'd like to sign up. One question: does it work with LabLink?" },
        { from: "owner@sideproject.example", date: iso(3 * 86400e3), preview: "Hi Ada, happy to show you ClinicFlow on Thursday at 13:00…" },
      ],
      web_link: "https://outlook.office.com/mail/drafts",
    },
  });
  page({
    id: "pg_ideas", intern: "coordinator", thread_key: "coordinator", kind: "list", title: "Ideas", summary: "4 ideas · 3 open", pinned: true, version: 5,
    data: {
      items: [
        { id: "i1", text: "Weekly people digest on Monday mornings", tags: ["app"], ts: iso(6 * 86400e3), source: { thread_key: "coordinator", message_id: "cd1" } },
        { id: "i2", text: "A talk at DevConf about running an AI intern crew", tags: ["content"], ts: iso(4 * 86400e3) },
        { id: "i3", text: "ClinicFlow referral discount for practices that bring a colleague", tags: ["business"], ts: iso(2 * 86400e3) },
        { id: "i4", text: "Learn to sail", tags: ["someday"], ts: iso(9 * 86400e3), done: true },
      ],
    },
  });

  const rules = new Map();
  const rule = (r) => rules.set(r.id, { kind: "hard", enabled: true, hits: 0, hits_7d: 0, last_hit_at: null, created_from_message: null, created_at: iso(5 * 86400e3), removed_at: null, params: {}, ...r });
  rule({ id: "rl_webapp", intern: "nia", type: "mute_repo", params: { repo: "northwind/webapp" }, text: "Ignore all webapp PRs — no messages, no cards", hits: 14, hits_7d: 6, last_hit_at: iso(3 * 3600e3) });
  rule({ id: "rl_deploy", intern: "milo", type: "mute_sender", params: { domain: "deploymanager.io" }, text: "Ignore Deployment Manager digests", hits: 23, hits_7d: 9, last_hit_at: iso(40 * 60e3) });
  rule({ id: "rl_afr", intern: "milo", kind: "soft", type: "guidance", text: "Write to Kettle Labs in Afrikaans" });

  // ---- fixture messages that carry the new blocks
  messages.milo.push(
    { id: "mf1", intern: "milo", author: "jp", text: "Give me all my people", ts: iso(50 * 60e3), surface: "app", attachments: [] },
    { id: "mf2", intern: "milo", author: "intern", speaker: "milo", text: `Here's everyone I'm tracking — two follow-ups are due.\n\n${fence("page", { id: "pg_people", title: "My people", kind: "people" })}`, ts: iso(49 * 60e3), surface: "system", attachments: [] },
    { id: "mf3", intern: "milo", author: "intern", speaker: "milo", text: `Reply to Ada is drafted as a proper reply-all — Lena stays on CC and the thread is quoted underneath.\n\n${fence("page", { id: "pg_draft", title: "RE: ClinicFlow for Willowbrook Vet", kind: "draft" })}\n\n— Milo, draft's in Outlook`, ts: iso(20 * 60e3), surface: "system", attachments: [] },
    { id: "mf4", intern: "milo", author: "intern", speaker: "milo", text: `How did **ClinicFlow demo — Willowbrook Vet** go? (with Ada)\n\n${fence("quick-replies", { options: ["Went well", "Needs follow-up", "Didn't happen", "Skip"] })}`, ts: iso(5 * 60e3), surface: "system", attachments: [] },
  );
  messages.zara.push(
    { id: "zf1", intern: "zara", author: "jp", text: "Stop pinging me about the staging disk at night", ts: iso(2 * 3600e3), surface: "app", attachments: [] },
    { id: "zf2", intern: "zara", author: "intern", speaker: "zara", text: `Understood — nights are quiet from now on.\n\n${fence("rule", { id: "rl_quiet", text: "No pings between 21:00 and 07:00", kind: "hard" })}`, ts: iso(2 * 3600e3 - 60e3), surface: "system", attachments: [] },
    { id: "zf3", intern: "zara", author: "intern", speaker: "zara", text: `Staging disk is at 91%. I can clear it up — pick what you want:\n\n${fence("checklist", { id: "disk", title: "Free up staging disk", items: [{ id: "1", text: "Prune Docker images older than 14 days (~18 GB)", checked: true }, { id: "2", text: "Rotate and gzip nginx logs (~4 GB)", checked: true }, { id: "3", text: "Delete old DB dumps in /srv/backups", checked: false }], submit: "Do these" })}`, ts: iso(30 * 60e3), surface: "system", attachments: [] },
  );
  for (const [id, text] of [["rl_z1", "Report disk only above 90%"], ["rl_z2", "Never restart production without asking"], ["rl_z3", "Weekly summary on Fridays, nothing daily"]]) {
    rule({ id, intern: "zara", kind: "soft", type: "guidance", text });
  }
  messages.zara.splice(2, 0, {
    id: "zf2b", intern: "zara", author: "intern", speaker: "zara", ts: iso(2 * 3600e3 - 30e3), surface: "system", attachments: [],
    text: `And the rest of what you've told me, saved:\n\n${["rl_z1", "rl_z2", "rl_z3"].map((id) => fence("rule", { id, text: rules.get(id).text, kind: "soft" })).join("\n\n")}`,
  });
  rule({ id: "rl_quiet", intern: "zara", type: "quiet_hours", params: { from: "21:00", to: "07:00" }, text: "No pings between 21:00 and 07:00", hits: 3, hits_7d: 3, last_hit_at: iso(9 * 3600e3) });
  messages.nia.push(
    { id: "nf1", intern: "nia", author: "intern", speaker: "nia", text: `Updated the events board: added **Vet Congress** and a description column.\n\n${fence("page", { id: "pg_events", title: "Events, Oct–Dec", kind: "table" })}`, ts: iso(10e3), surface: "system", attachments: [] },
  );
  messages.coordinator = [
    { id: "cd1", intern: "coordinator", author: "jp", text: "idea: weekly people digest on Monday mornings", ts: iso(6 * 86400e3), surface: "app", attachments: [] },
    { id: "cd2", intern: "coordinator", author: "coordinator", speaker: null, reply_to: "cd1", text: `💡 Saved to Ideas (1)\n\n${fence("page", { id: "pg_ideas", title: "Ideas", kind: "list" })}`, ts: iso(6 * 86400e3 - 1e3), surface: "system", attachments: [] },
    { id: "cd3", intern: "coordinator", author: "jp", text: "who do I owe a follow-up?", ts: iso(40 * 60e3), surface: "app", attachments: [] },
    { id: "cd4", intern: "coordinator", author: "intern", speaker: "milo", reply_to: "cd3", text: "Two: **Ada** (overdue since yesterday — draft is ready) and **Danny at Kettle Labs** (today). Want me to draft Danny's in Afrikaans?", ts: iso(39 * 60e3), surface: "system", attachments: [] },
  ];

  // ---- a Today: briefs + debrief on fixture meetings
  const schedule = () => [
    { event_id: "ev1", start: atToday("09:00"), end: atToday("09:30"), all_day: false, title: "IoT Check-In", cancelled: false,
      attendees: [{ name: "Pieter", email: "pieter@northwind.example", external: false }, { name: "Tom", email: "tom@northwind.example", external: false }],
      brief: { intern: "nia", markdown: "**FlowMeter alarms** fired 38 times in 4 days on a 2-hour clock — likely the retry timer, not the devices. Ask Pieter whether the firmware push landed." } },
    { event_id: "ev2", start: atToday("11:00"), end: atToday("12:00"), all_day: false, title: "ClinicFlow demo — Willowbrook Vet", cancelled: false,
      attendees: [{ name: "Ada Okafor", email: "ada@willowbrook-vet.example", external: true }, { name: "Lena", email: "lena@sideproject.example", external: false }],
      location: "Teams", brief: { intern: "milo", markdown: "Single-vet practice in Durban. **Asked about LabLink** — have the Q1 roadmap answer ready. Price sensitivity: high." },
      debrief: { state: "asked", intern: "milo", message_id: "mf4" } },
    { event_id: "ev3", start: atToday("15:30"), end: atToday("16:15"), all_day: false, title: "Harbor & Co Dashboard with Victor", cancelled: false,
      attendees: [{ name: "Victor", email: "victor@harbor.example", external: true }], location: "Harbor & Co office" },
    { event_id: "ev4", start: atToday("17:00"), end: atToday("17:30"), all_day: false, title: "Canceled: Weekly sync", cancelled: true, attendees: [] },
  ];

  const isDecision = (c) => c.severity !== "info" || c.actions.some((a) => !["seen", "ack", "read", "ok", "noted", "dismiss", "close"].includes(a.id));
  cards.push({
    id: "c-fyi", intern: "nia", title: "Tender portal: annexure B re-uploaded (no changes)", body: "Checked line by line — identical to the version you saw on Monday.",
    severity: "info", state: "open", actions: [{ id: "seen", label: "Seen", style: "primary", kind: "button" }],
    created_at: iso(2 * 3600e3), updated_at: iso(2 * 3600e3), resolved_at: null, snoozed_until: null, resolution: null, discord_message_id: null, context: {},
  });

  const readBody = (req) => new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); }
    });
  });

  /** pasted moodboard images */
  const mediaStore = new Map();
  const bump = (p) => {
    p.version += 1;
    p.updated_at = new Date().toISOString();
    emit("page", { id: p.id, version: p.version, intern: p.intern, thread_key: p.thread_key, pinned: p.pinned, archived: Boolean(p.archived_at) });
  };
  const header = ({ data, ...rest }) => ({ ...rest, items: (data.people ?? data.items ?? data.rows ?? []).length });
  const internName = (slug) => interns.find((i) => i.slug === slug)?.name ?? slug;

  function captureIdea(text, source) {
    const ideas = pages.get("pg_ideas");
    ideas.data.items.push({ id: `i${Date.now()}`, text, tags: /app/i.test(text) ? ["app"] : [], ts: new Date().toISOString(), ...(source ? { source } : {}) });
    const open = ideas.data.items.filter((i) => !i.done).length;
    ideas.summary = `${ideas.data.items.length} ideas · ${open} open`;
    bump(ideas);
    return ideas.data.items.length;
  }

  /** Returns true when the request was handled here. */
  function handle(req, res, path, url, json) {
    let m;
    if (path === "/agenda" && req.method === "GET") {
      const date = url.searchParams.get("date") ?? ymd(new Date());
      const today = date === ymd(new Date());
      const open = cards.filter((c) => c.state === "open");
      const people = pages.get("pg_people").data.people;
      json(200, {
        date,
        generated_at: new Date().toISOString(),
        needs_you: open.filter(isDecision),
        fyi: open.filter((c) => !isDecision(c)),
        schedule: today ? schedule() : [],
        follow_ups: people
          .filter((p) => p.next_follow_up && p.next_follow_up <= date)
          .map((p) => ({ person_id: p.id, page_id: "pg_people", name: p.name, company: p.company, due: p.next_follow_up, overdue: p.next_follow_up < date, intern: "milo" })),
        away: today
          ? [
              { intern: "nia", summary: "Nia reviewed 3 PRs, muted 2 by standing order", count: 5 },
              { intern: "milo", summary: "Milo triaged 14 emails, prepared 2 meeting briefs", count: 6 },
              { intern: "zara", summary: "Zara ran 4 routines", count: 4 },
            ]
          : [],
        ...(today ? { standup: { message_id: "su", ts: atToday("07:00"), markdown: "**Morning.** Milo has 2 follow-ups due and a reply-all draft for Ada. Nia's events board gained Vet Congress. Zara: staging disk at 91%." } } : {}),
      });
      return true;
    }
    if (path === "/pages/search" && req.method === "GET") {
      // Same rule as the orchestrator's searchPages(): every word somewhere in the item.
      const words = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const flat = (v) => (v && typeof v === "object" ? Object.values(v).map(flat).join(" ") : String(v ?? ""));
      const hits = [];
      for (const p of pages.values()) {
        const list = p.data.people ?? p.data.items ?? p.data.rows ?? [];
        for (const item of list) {
          const hay = flat(item).toLowerCase();
          if (!words.length || !words.every((w) => hay.includes(w))) continue;
          const label = item.name ?? item.title ?? item.text ?? item.name ?? item.id;
          hits.push({ page_id: p.id, page_title: p.title, kind: p.kind, intern: p.intern, item_id: item.id, label, detail: [item.company, item.stage, item.subtitle, item.when].filter(Boolean).join(" · ") });
        }
      }
      json(200, { hits: hits.slice(0, 30) });
      return true;
    }
    if ((m = /^\/pages\/([^/]+)\/media$/.exec(path)) && req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const name = `${Date.now().toString(36)}abcdef.png`;
        mediaStore.set(name, { bytes: Buffer.concat(chunks), type: req.headers["content-type"] ?? "image/png" });
        json(201, { image: `media:${name}`, url: `/pages/${m[1]}/media/${name}?sig=mock` });
      });
      return true;
    }
    if ((m = /^\/pages\/([^/]+)\/media\/([^/]+)$/.exec(path)) && req.method === "GET") {
      const media = mediaStore.get(m[2]);
      if (!media) return json(404, { error: "no such image" }), true;
      res.writeHead(200, { "Content-Type": media.type, "Access-Control-Allow-Origin": "*" });
      res.end(media.bytes);
      return true;
    }
    if ((m = /^\/pages\/([^/]+)\/items$/.exec(path)) && req.method === "POST") {
      void readBody(req).then(({ item = {} }) => {
        const p = pages.get(m[1]);
        if (!p) return json(404, { error: "no such page" });
        const view = { tags: [], ...item };
        if (typeof view.image === "string" && view.image.startsWith("media:")) view.image_url = `/pages/${p.id}/media/${view.image.slice(6)}?sig=mock`;
        p.data.items.push(view);
        bump(p);
        json(200, p);
        // a link gets its preview a moment later, like the real orchestrator
        if (view.url && !view.image) {
          setTimeout(() => {
            Object.assign(view, { image: "media:preview.jpg", image_url: swatch("#264653", "#2a9d8f", "preview"), title: view.title ?? "Shared reel", source: view.source ?? "Instagram" });
            bump(p);
          }, 1500);
        }
      });
      return true;
    }
    if ((m = /^\/pages\/([^/]+)$/.exec(path)) && req.method === "GET") {
      const p = pages.get(m[1]);
      json(p ? 200 : 404, p ?? { error: "no such page" });
      return true;
    }
    if ((m = /^\/interns\/([^/]+)\/pages$/.exec(path)) && req.method === "GET") {
      json(200, { pages: [...pages.values()].filter((p) => (p.intern === m[1] || p.thread_key === m[1]) && !p.archived_at).map(header) });
      return true;
    }
    if ((m = /^\/pages\/([^/]+)\/pin$/.exec(path)) && req.method === "POST") {
      void readBody(req).then(({ pinned = true }) => {
        const p = pages.get(m[1]);
        if (!p) return json(404, { error: "no such page" });
        p.pinned = pinned;
        emit("page", { id: p.id, version: p.version, intern: p.intern, thread_key: p.thread_key, pinned: p.pinned, archived: false });
        json(200, p);
      });
      return true;
    }
    if ((m = /^\/pages\/([^/]+)\/items\/([^/]+)$/.exec(path)) && (req.method === "PATCH" || req.method === "DELETE")) {
      void readBody(req).then(({ set = {} }) => {
        const p = pages.get(m[1]);
        if (!p) return json(404, { error: "no such page" });
        const key = p.data.people ? "people" : p.data.rows ? "rows" : "items";
        const list = p.data[key];
        const i = list.findIndex((x) => x.id === m[2]);
        if (i === -1) return json(404, { error: "no such item" });
        if (req.method === "DELETE") list.splice(i, 1);
        else list[i] = { ...list[i], ...set, id: list[i].id };
        if (p.id === "pg_ideas") p.summary = `${list.length} ideas · ${list.filter((x) => !x.done).length} open`;
        bump(p);
        json(200, p);
      });
      return true;
    }
    if ((m = /^\/interns\/([^/]+)\/rules$/.exec(path)) && req.method === "GET") {
      json(200, { rules: [...rules.values()].filter((r) => r.intern === m[1] && !r.removed_at) });
      return true;
    }
    if ((m = /^\/rules\/([^/]+)$/.exec(path))) {
      const r = rules.get(m[1]);
      if (!r) {
        json(404, { error: "no such rule" });
        return true;
      }
      if (req.method === "GET") json(200, r);
      else if (req.method === "DELETE") {
        r.removed_at = new Date().toISOString();
        r.enabled = false;
        emit("rule", r);
        json(200, { ok: true, rule: r });
      } else if (req.method === "PATCH") {
        void readBody(req).then((patch) => {
          Object.assign(r, patch);
          emit("rule", r);
          json(200, r);
        });
      } else return false;
      return true;
    }
    if (path === "/ideas" && req.method === "POST") {
      void readBody(req).then(({ text = "", source }) => {
        const count = captureIdea(text, source);
        json(201, { page_id: "pg_ideas", item_id: "new", count });
      });
      return true;
    }
    if ((m = /^\/cards\/([^/]+)\/actions\/seen$/.exec(path)) && req.method === "POST") {
      const card = cards.find((c) => c.id === m[1]);
      if (!card) return json(404, { error: "no such card" }), true;
      Object.assign(card, { state: "resolved", resolved_at: new Date().toISOString(), resolution: { via: "app", action: "seen" } });
      emit("card_state", card);
      json(200, card);
      return true;
    }
    return false;
  }

  /**
   * Called by the base POST /interns/:slug/messages route once Sam's message
   * is built: ideas in any thread, debrief Skip / answers, and the front
   * desk's routing. Returns true when it answered the request.
   */
  function intercept(slug, body, message, json) {
    const ideaRe = /^\s*(?:idea\s*:|💡)\s*/i;
    const text = String(body.text ?? "");
    const thread = (messages[slug] ??= []);
    const post = (msg) => {
      thread.push(msg);
      emit("message", msg);
    };
    const later = (fn) => setTimeout(fn, Number(process.env.REPLY_DELAY_MS ?? 1200));
    if (ideaRe.test(text)) {
      post(message);
      const count = captureIdea(text.replace(ideaRe, ""), { thread_key: slug, message_id: message.id });
      post({ id: `${message.id}a`, intern: slug, author: "coordinator", speaker: null, reply_to: message.id, text: `💡 Saved to Ideas (${count})`, ts: new Date().toISOString(), surface: "system", attachments: [] });
      json(200, { message, task_id: "", targets: [] });
      return true;
    }
    if (body.reply_to === "mf4") {
      post(message);
      if (/^\s*skip\s*$/i.test(text)) {
        json(200, { message, task_id: "", targets: [] });
        return true;
      }
      json(200, { message, task_id: "t-debrief", targets: ["milo"] });
      later(() => post({ id: `${message.id}r`, intern: "milo", author: "intern", speaker: "milo", reply_to: message.id,
        text: `Great news. Here's what I'd do next:\n\n${fence("checklist", { id: "next", title: "Next steps for Willowbrook Vet", items: [{ id: "1", text: "Move Willowbrook Vet to Signed on the pipeline", checked: true }, { id: "2", text: "Send the onboarding pack (reply-all, Lena on CC)", checked: true }, { id: "3", text: "Follow up Fri: check the account is set up", checked: true }, { id: "4", text: "Tell Lena", checked: false }], submit: "Do these" })}`,
        ts: new Date().toISOString(), surface: "system", attachments: [] }));
      return true;
    }
    if (slug === "coordinator") {
      post(message);
      json(200, { message, task_id: "t-desk", targets: ["milo"] });
      later(() => post({ id: `${message.id}r`, intern: "coordinator", author: "intern", speaker: "milo", reply_to: message.id, text: `On it — I'll look into “${text.slice(0, 60)}”.\n\n— Milo, routed from the front desk`, ts: new Date().toISOString(), surface: "system", attachments: [] }));
      return true;
    }
    return false;
  }

  /** <img src> for a moodboard image: signed, no bearer (like attachments). */
  function serveMedia(path, res, cors) {
    const m = /^\/pages\/[^/]+\/media\/([^/]+)$/.exec(path);
    const media = m && mediaStore.get(m[1]);
    if (!media) return false;
    res.writeHead(200, { ...cors, "Content-Type": media.type });
    res.end(media.bytes);
    return true;
  }

  return { handle, intercept, internName, serveMedia };
}
