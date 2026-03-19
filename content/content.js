// content.js — runs inside the LinkedIn tab, makes Voyager API calls

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE_URL    = "https://www.linkedin.com";
const PAGE_SIZE   = 40;
const BASE_DELAY  = 1500; // ms between pages
const JITTER      = 1000; // ms of random additional delay
const MAX_RETRIES = 3;

// ─── State ────────────────────────────────────────────────────────────────────
let stopped = false;

// ─── Message listener ─────────────────────────────────────────────────────────
if (!window.__linkedinScraperActive) {
  window.__linkedinScraperActive = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "start") {
      stopped = false;
      runScraper(message).catch(err => {
        reportError(err.message ?? String(err));
      });
      sendResponse({ ok: true });
    }
    if (message.action === "stop") {
      stopped = true;
      sendResponse({ ok: true });
    }
    return false;
  });
}

// ─── Main scraper ─────────────────────────────────────────────────────────────
async function runScraper({ schoolName, currentlyEnrolledOnly, csrfToken }) {
  const allConnections = [];
  let start = 0;
  let total = null;
  let skipped = 0;

  while (!stopped) {
    reportStatus(`Fetching page starting at ${start}…`);

    const json = await fetchConnectionsPage(start, csrfToken);
    if (!json) return;

    // LinkedIn normalized JSON: root data lives under json.data, related
    // entities live in json.included (array). Some older decorations put
    // everything at the root. Handle both.
    const root     = json.data ?? json;
    const included = json.included ?? [];
    const paging   = root.paging ?? root.metadata?.paging;
    const elements = root.elements ?? [];

    if (total === null) {
      total = paging?.total ?? 0;
    }

    // Build a URN → entity lookup from included
    const byUrn = buildUrnMap(included);

    console.log("[LI Scraper] page start=" + start,
      "elements:", elements.length,
      "included:", included.length,
      "total:", total,
      "sample element:", JSON.stringify(elements[0] ?? {}).slice(0, 300));

    for (const element of elements) {
      const conn = parseConnection(element, byUrn, included);
      if (!conn) { skipped++; continue; }
      allConnections.push(conn);
    }

    const fetched = start + elements.length;
    reportProgress(fetched, total);

    if (elements.length === 0 || fetched >= total) break;
    start = fetched;

    const delay = BASE_DELAY + Math.random() * JITTER;
    await sleep(delay);
  }

  if (stopped) return;

  // Filter connections
  const results = [];
  for (const conn of allConnections) {
    const matchedEdu = findMatchingEducation(conn.educations, schoolName, currentlyEnrolledOnly);
    if (matchedEdu) {
      results.push({ ...conn, matchedEducation: matchedEdu });
    }
  }

  console.log("[LI Scraper] done. total fetched:", allConnections.length,
    "matched:", results.length, "skipped (no profile):", skipped);

  chrome.runtime.sendMessage({ action: "saveResults", data: { results, skipped, schoolName } });
  chrome.runtime.sendMessage({ action: "complete", results, skipped });
}

// ─── Build URN → entity map from included array ───────────────────────────────
function buildUrnMap(included) {
  const map = {};
  for (const item of included) {
    if (item.entityUrn) map[item.entityUrn] = item;
    // Some items use *id or trackingUrn as alternate keys
    if (item['*id']) map[item['*id']] = item;
  }
  return map;
}

// ─── Parse a connection element ───────────────────────────────────────────────
function parseConnection(element, byUrn, included) {
  // Resolve the profile — may be inline object OR a URN string to look up
  let profile = element.connectedMemberResolutionResult;
  if (typeof profile === "string") {
    profile = byUrn[profile] ?? null;
  }

  // Fallback: try other common keys
  if (!profile) {
    const profileUrn = element['*profile'] ?? element['*connectedMember'];
    if (profileUrn) profile = byUrn[profileUrn] ?? null;
  }

  if (!profile) {
    console.log("[LI Scraper] no profile for element:", JSON.stringify(element).slice(0, 200));
    return null;
  }

  // Extract education — may be inline or referenced by URNs in included
  const educations = extractEducations(profile, byUrn, included);

  return {
    firstName:  profile.firstName   ?? profile.localizedFirstName  ?? "",
    lastName:   profile.lastName    ?? profile.localizedLastName   ?? "",
    headline:   profile.headline    ?? profile.localizedHeadline   ?? "",
    profileUrl: profile.publicIdentifier
      ? `https://www.linkedin.com/in/${profile.publicIdentifier}/`
      : (profile.vanityName ? `https://www.linkedin.com/in/${profile.vanityName}/` : ""),
    entityUrn:  profile.entityUrn   ?? "",
    educations,
  };
}

// ─── Education extraction ─────────────────────────────────────────────────────
function extractEducations(profile, byUrn, included) {
  const results = [];

  // Strategy 1: inline elements array
  const inlineElements = profile.educations?.elements ?? profile.education?.elements ?? [];
  for (const edu of inlineElements) {
    const resolved = (typeof edu === "string") ? (byUrn[edu] ?? null) : edu;
    if (resolved) results.push(parseEducation(resolved));
  }

  if (results.length > 0) return results;

  // Strategy 2: URN list under various keys
  const eduUrns = profile['*educations'] ?? profile['*education'] ?? [];
  for (const urn of eduUrns) {
    const edu = byUrn[urn];
    if (edu) results.push(parseEducation(edu));
  }

  if (results.length > 0) return results;

  // Strategy 3: Scan included for Education entities that reference this profile
  const profileUrn = profile.entityUrn ?? "";
  for (const item of included) {
    const t = item['$type'] ?? item.type ?? "";
    if (!t.toLowerCase().includes("education")) continue;

    // Check if this education entry belongs to this profile
    const ownerUrn = item['*profile'] ?? item.profileId ?? item.profileUrn ?? "";
    if (ownerUrn && profileUrn && !profileUrn.includes(ownerUrn) && !ownerUrn.includes(profileUrn)) continue;

    results.push(parseEducation(item));
  }

  return results;
}

function parseEducation(edu) {
  const startYear  = edu?.dateRange?.start?.year  ?? edu?.startYear  ?? null;
  const endYear    = edu?.dateRange?.end?.year    ?? edu?.endYear    ?? null;
  const endMonth   = edu?.dateRange?.end?.month   ?? null;
  const hasEndDate = (edu?.dateRange?.end != null) || (endYear != null);

  return {
    schoolName:       edu?.schoolName   ?? edu?.school?.name ?? "",
    degreeName:       edu?.degreeName   ?? edu?.degree?.name ?? "",
    fieldOfStudy:     edu?.fieldOfStudy ?? edu?.fieldOfStudyV2?.name ?? "",
    startYear,
    endYear,
    endMonth,
    currentlyEnrolled: detectEnrolled(hasEndDate, endYear, endMonth),
  };
}

// ─── Enrollment detection ─────────────────────────────────────────────────────
function detectEnrolled(hasEndDate, endYear, endMonth) {
  if (!hasEndDate) return true; // no end date = still attending

  if (endYear == null) return false;

  const now = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (endYear > currentYear) return true;
  if (endYear === currentYear && (endMonth == null || endMonth >= currentMonth)) return true;
  return false;
}

// ─── Filter ───────────────────────────────────────────────────────────────────
function findMatchingEducation(educations, schoolQuery, currentlyEnrolledOnly) {
  const query = schoolQuery.toLowerCase().trim();
  for (const edu of educations) {
    if (!edu.schoolName.toLowerCase().includes(query)) continue;
    if (currentlyEnrolledOnly && !edu.currentlyEnrolled) continue;
    return edu;
  }
  return null;
}

// ─── Voyager API fetch ────────────────────────────────────────────────────────
async function fetchConnectionsPage(start, csrfToken, attempt = 1) {
  const url = new URL(`${BASE_URL}/voyager/api/relationships/dash/connections`);
  url.searchParams.set("decorationId", "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15");
  url.searchParams.set("count", String(PAGE_SIZE));
  url.searchParams.set("q", "search");
  url.searchParams.set("sortType", "RECENTLY_ADDED");
  url.searchParams.set("start", String(start));

  const headers = {
    "accept": "application/vnd.linkedin.normalized+json+2.1",
    "accept-language": "en-US,en;q=0.9",
    "csrf-token": csrfToken,
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "x-li-track": JSON.stringify({
      clientVersion: "1.13.9872",
      mpVersion: "1.13.9872",
      osName: "web",
      timezoneOffset: new Date().getTimezoneOffset() / -60,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      deviceFormFactor: "DESKTOP",
      mpName: "voyager-web",
    }),
  };

  let response;
  try {
    response = await fetch(url.toString(), { method: "GET", headers, credentials: "include" });
  } catch (err) {
    reportError(`Network error: ${err.message}`);
    return null;
  }

  if (response.status === 999) {
    reportError("LinkedIn's anti-bot page was triggered (999). Wait a few minutes, refresh LinkedIn, and try again.");
    return null;
  }
  if (response.status === 429) {
    if (attempt <= MAX_RETRIES) {
      reportStatus(`Rate limited. Waiting 10s… (retry ${attempt}/${MAX_RETRIES})`);
      await sleep(10000);
      return fetchConnectionsPage(start, csrfToken, attempt + 1);
    }
    reportError("Rate limited too many times. Wait a few minutes and try again.");
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    reportError("Auth error. Make sure you're logged in to LinkedIn and try again.");
    return null;
  }
  if (!response.ok) {
    reportError(`LinkedIn API returned ${response.status}. Please try again.`);
    return null;
  }

  try {
    return await response.json();
  } catch {
    reportError("Failed to parse LinkedIn API response.");
    return null;
  }
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function reportProgress(fetched, total) {
  chrome.runtime.sendMessage({ action: "progress", fetched, total });
}
function reportStatus(text) {
  chrome.runtime.sendMessage({ action: "status", text });
}
function reportError(message) {
  chrome.runtime.sendMessage({ action: "error", message });
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
