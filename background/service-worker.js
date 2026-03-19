// service-worker.js — background service worker for the LinkedIn Scraper extension
// Responsibilities:
//   1. Cache scrape results in chrome.storage.session so they survive popup close/reopen
//   2. Relay messages between content script and popup when needed

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Content script sends this after a successful scrape
  if (message.action === "saveResults") {
    chrome.storage.session.set({ scrapedResults: message.data }).catch(console.error);
    return false;
  }

  // Popup requests cached results on open
  if (message.action === "getResults") {
    chrome.storage.session.get("scrapedResults")
      .then(data => sendResponse(data.scrapedResults ?? null))
      .catch(() => sendResponse(null));
    return true; // keeps the message channel open for async response
  }

  // Clear cache when user explicitly resets
  if (message.action === "clearResults") {
    chrome.storage.session.remove("scrapedResults").catch(console.error);
    return false;
  }
});
