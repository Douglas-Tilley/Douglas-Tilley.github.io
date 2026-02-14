(function () {
  "use strict";

  var SECTION_SELECTOR = ".js-repo-section";
  var repoCache = new Map();

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(isoDate) {
    if (!isoDate) {
      return "";
    }

    var date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function toArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function readConfig(section) {
    var configElement = section.querySelector(".js-repo-config");
    if (!configElement) {
      return null;
    }

    try {
      return JSON.parse(configElement.textContent);
    } catch (error) {
      return null;
    }
  }

  function normalizeRepo(repo) {
    return {
      name: repo.name || "Unnamed repository",
      html_url: repo.html_url || "#",
      description: repo.description || "No description provided yet.",
      language: repo.language || "",
      stargazers_count: Number(repo.stargazers_count) || 0,
      pushed_at: repo.pushed_at || "",
      fork: Boolean(repo.fork),
      archived: Boolean(repo.archived),
    };
  }

  function normalizeFallbackRepos(fallbackRepos) {
    return toArray(fallbackRepos).map(function (repo) {
      return normalizeRepo(repo);
    });
  }

  function dedupeByName(repos) {
    var seen = new Set();
    var unique = [];

    repos.forEach(function (repo) {
      var key = String(repo.name || "").toLowerCase();
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      unique.push(repo);
    });

    return unique;
  }

  function sortByRecentUpdate(repos) {
    return repos.slice().sort(function (left, right) {
      var leftDate = new Date(left.pushed_at || 0).getTime();
      var rightDate = new Date(right.pushed_at || 0).getTime();
      return rightDate - leftDate;
    });
  }

  function prioritizeRepos(repos, selectedRepos) {
    var selected = toArray(selectedRepos).map(function (name) {
      return String(name).toLowerCase();
    });

    var byName = new Map(
      repos.map(function (repo) {
        return [String(repo.name).toLowerCase(), repo];
      })
    );

    var prioritized = [];
    selected.forEach(function (name) {
      var repo = byName.get(name);
      if (repo) {
        prioritized.push(repo);
      }
    });

    var prioritizedNames = new Set(
      prioritized.map(function (repo) {
        return String(repo.name).toLowerCase();
      })
    );

    var remainder = repos.filter(function (repo) {
      return !prioritizedNames.has(String(repo.name).toLowerCase());
    });

    return prioritized.concat(remainder);
  }

  function buildFallbackOrder(fallbackRepos, selectedRepos) {
    var fallback = normalizeFallbackRepos(fallbackRepos);
    return prioritizeRepos(fallback, selectedRepos);
  }

  async function fetchUserRepos(username) {
    var key = String(username || "");
    if (!key) {
      return [];
    }

    if (!repoCache.has(key)) {
      var request = fetch(
        "https://api.github.com/users/" +
          encodeURIComponent(key) +
          "/repos?per_page=100&sort=updated",
        {
          headers: {
            Accept: "application/vnd.github+json",
          },
        }
      ).then(function (response) {
        if (!response.ok) {
          throw new Error("GitHub API request failed");
        }
        return response.json();
      });

      repoCache.set(key, request);
    }

    return repoCache.get(key);
  }

  function renderRepoCard(repo) {
    var metaItems = [];
    if (repo.language) {
      metaItems.push("<li>" + escapeHtml(repo.language) + "</li>");
    }
    metaItems.push("<li>Stars " + escapeHtml(repo.stargazers_count) + "</li>");
    if (repo.pushed_at) {
      metaItems.push("<li>Updated " + escapeHtml(formatDate(repo.pushed_at)) + "</li>");
    }

    return (
      '<article class="repo-card">' +
      '<h3 class="repo-card__title"><a href="' +
      escapeHtml(repo.html_url) +
      '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(repo.name) +
      "</a></h3>" +
      '<p class="repo-card__description">' +
      escapeHtml(repo.description) +
      "</p>" +
      '<ul class="repo-card__meta">' +
      metaItems.join("") +
      "</ul>" +
      "</article>"
    );
  }

  function renderRepos(gridElement, repos) {
    gridElement.innerHTML = repos.map(renderRepoCard).join("");
  }

  function pickReposFromApi(apiRepos, config) {
    var selectedRepos = toArray(config.selectedRepos);
    var maxItems = Number(config.maxItems) || 6;

    var cleaned = toArray(apiRepos)
      .map(normalizeRepo)
      .filter(function (repo) {
        return !repo.fork && !repo.archived;
      });

    var ordered = prioritizeRepos(sortByRecentUpdate(cleaned), selectedRepos);
    return ordered.slice(0, maxItems);
  }

  function addFallbackFill(primaryRepos, fallbackRepos, maxItems) {
    if (primaryRepos.length >= maxItems) {
      return primaryRepos.slice(0, maxItems);
    }

    var combined = dedupeByName(primaryRepos.concat(fallbackRepos));
    return combined.slice(0, maxItems);
  }

  async function hydrateSection(section) {
    var gridElement = section.querySelector(".js-repo-grid");
    var statusElement = section.querySelector(".js-repo-status");
    var config = readConfig(section);

    if (!gridElement || !statusElement || !config) {
      return;
    }

    var maxItems = Number(config.maxItems) || 6;
    var fallback = buildFallbackOrder(config.fallbackRepos, config.selectedRepos);
    var repos = [];
    var usingFallback = false;

    try {
      var apiRepos = await fetchUserRepos(config.username);
      repos = pickReposFromApi(apiRepos, config);
      repos = addFallbackFill(repos, fallback, maxItems);
    } catch (error) {
      usingFallback = true;
      repos = fallback.slice(0, maxItems);
    }

    repos = dedupeByName(repos).slice(0, maxItems);

    if (repos.length === 0) {
      statusElement.textContent = "No repositories available yet.";
      gridElement.innerHTML = "";
      return;
    }

    renderRepos(gridElement, repos);
    statusElement.textContent = usingFallback
      ? "GitHub API unavailable. Showing curated repositories."
      : "Here are some of the repositories I am working on (Links may not work due to privacy)";
  }

  function initRepoSections() {
    var sections = document.querySelectorAll(SECTION_SELECTOR);
    sections.forEach(function (section) {
      hydrateSection(section);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initRepoSections);
  } else {
    initRepoSections();
  }
})();
