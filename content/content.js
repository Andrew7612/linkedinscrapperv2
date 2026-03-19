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
// Guard: only register one listener even if the script is injected multiple times
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

    return false; // synchronous response
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

    const data = await fetchConnectionsPage(start, csrfToken);

    if (!data) {
      // fetchConnectionsPage already handled retry logic and reported the error
      return;
    }

    if (total === null) {
      total = data.paging?.total ?? 0;
    }

    const elements = data.elements ?? [];

    for (const element of elements) {
      const conn = parseConnection(element);
      if (!conn) { skipped++; continue; }
      if (!conn.educations.length) { skipped++; continue; }
      allConnections.push(conn);
    }

    const fetched = start + elements.length;
    reportProgress(fetched, total);

    if (elements.length === 0 || fetched >= total) break;
    start = fetched;

    // Rate-limit delay between pages
    const delay = BASE_DELAY + Math.random() * JITTER;
    await sleep(delay);
  }

  if (stopped) return;

  // Filter connections by criteria
  const results = [];
  for (const conn of allConnections) {
    const matchedEdu = findMatchingEducation(conn.educations, schoolName, currentlyEnrolledOnly);
    if (matchedEdu) {
      results.push({ ...conn, matchedEducation: matchedEdu });
    }
  }

  // Cache results in session storage via background SW
  chrome.runtime.sendMessage({
    action: "saveResults",
    data: { results, skipped, schoolName },
  });

  // Report completion to popup
  chrome.runtime.sendMessage({ action: "complete", results, skipped });
}

// ─── Voyager API fetch (with retry) ──────────────────────────────────────────
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
    response = await fetch(url.toString(), {
      method: "GET",
      headers,
      credentials: "include",
    });
  } catch (networkErr) {
    reportError(`Network error: ${networkErr.message}`);
    return null;
  }

  if (response.status === 999) {
    reportError(
      "LinkedIn's anti-bot page was triggered (999). " +
      "Wait a few minutes, refresh LinkedIn, then try again."
    );
    return null;
  }

  if (response.status === 429) {
    if (attempt <= MAX_RETRIES) {
      reportStatus(`Rate limited. Waiting 10 seconds… (retry ${attempt}/${MAX_RETRIES})`);
      await sleep(10000);
      return fetchConnectionsPage(start, csrfToken, attempt + 1);
    }
    reportError("Rate limited by LinkedIn too many times. Please wait a few minutes and try again.");
    return null;
  }

  if (response.status === 401 || response.status === 403) {
    reportError(
      "LinkedIn rejected the request (auth error). " +
      "Make sure you are logged in to LinkedIn and try again."
    );
    return null;
  }

  if (!response.ok) {
    reportError(`LinkedIn API returned status ${response.status}. Please try again.`);
    return null;
  }

  let json;
  try {
    json = await response.json();
  } catch (parseErr) {
    reportError("Failed to parse LinkedIn API response. Try again.");
    return null;
  }

  return json;
}

// ─── Parse a connection element from the API response ────────────────────────
function parseConnection(element) {
  // The profile is nested under connectedMemberResolutionResult
  const profile = element?.connectedMemberResolutionResult;
  if (!profile) return null;

  const educations = (profile.educations?.elements ?? []).map(parseEducation);

  return {
    firstName:  profile.firstName  ?? "",
    lastName:   profile.lastName   ?? "",
    headline:   profile.headline   ?? "",
    profileUrl: profile.publicIdentifier
      ? `https://www.linkedin.com/in/${profile.publicIdentifier}/`
      : "",
    entityUrn:  profile.entityUrn  ?? "",
    educations,
  };
}

function parseEducation(edu) {
  const startYear  = edu?.dateRange?.start?.year  ?? null;
  const endYear    = edu?.dateRange?.end?.year    ?? null;
  const endMonth   = edu?.dateRange?.end?.month   ?? null;
  const hasEndDate = edu?.dateRange?.end != null;

  return {
    schoolName:       edu?.schoolName    ?? "",
    degreeName:       edu?.degreeName    ?? "",
    fieldOfStudy:     edu?.fieldOfStudy  ?? "",
    startYear,
    endYear,
    endMonth,
    currentlyEnrolled: detectEnrolled(hasEndDate, endYear, endMonth),
  };
}

// ─── Currently-enrolled detection ────────────────────────────────────────────
function detectEnrolled(hasEndDate, endYear, endMonth) {
  // No end date on the entry = still attending
  if (!hasEndDate) return true;

  if (endYear == null) return false; // malformed

  const now = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-indexed

  if (endYear > currentYear) return true;
  if (endYear === currentYear && (endMonth == null || endMonth >= currentMonth)) return true;
  return false;
}

// ─── Filter: find the best matching education entry ───────────────────────────
function findMatchingEducation(educations, schoolQuery, currentlyEnrolledOnly) {
  const query = schoolQuery.toLowerCase().trim();

  for (const edu of educations) {
    const schoolLower = edu.schoolName.toLowerCase();
    if (!schoolLower.includes(query)) continue;

    // School matches — now check enrollment if required
    if (currentlyEnrolledOnly && !edu.currentlyEnrolled) continue;

    return edu; // Return the first matching entry
  }
  return null;
}

// ─── Message helpers ──────────────────────────────────────────────────────────
function reportProgress(fetched, total) {
  chrome.runtime.sendMessage({ action: "progress", fetched, total });
}

function reportStatus(text) {
  chrome.runtime.sendMessage({ action: "status", text });
}

function reportError(message) {
  chrome.runtime.sendMessage({ action: "error", message });
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
