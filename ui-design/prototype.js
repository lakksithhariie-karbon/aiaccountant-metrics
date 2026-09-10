/* Retention UI. Live: same-origin /health /api/*. ?offline=1 uses fixtures. */
(function () {
  "use strict";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var REL_MIN = 0, REL_MAX = 8;
  var offline = new URLSearchParams(window.location.search).get("offline") === "1";

  var $ = function (id) { return document.getElementById(id); };
  var heatmapBody = $("heatmap-body"), heatmapEmpty = $("heatmap-empty");
  var peopleStatus = $("people-status"), peopleDetail = $("people-detail");
  var peopleTitle = $("people-title"), peopleList = $("people-list");
  var companyStatus = $("company-status"), companyDetail = $("company-detail");
  var companyName = $("company-name"), companyPath = $("company-path"), companyStats = $("company-stats");
  var byWeekBody = $("company-byweek-body"), byEventBody = $("company-byevent-body");
  var timelineCount = $("timeline-count"), timelineList = $("timeline-list");
  var timelineNewest = $("timeline-newest"), timelineOlder = $("timeline-older");
  var search = $("search");
  var cellTitle = $("cell-title"), cellShares = $("cell-shares");
  var apiError = $("api-error"), appViews = $("app-views");
  var filterSelect = $("activation-weeks");

  var currentUsers = [];
  var currentKey = null;
  var selectedCompanyId = null;
  var timelineState = { companyId: null, offset: 0, total: null };
  var isDown = false;
  var lastCellBtn = null;
  var cellReq = 0;
  var companyReq = 0;
  var weekFilter = readWeekFilter();

  function snapWeek(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var d = new Date(value + "T00:00:00Z");
    if (isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  function readWeekFilter() {
    var params = new URLSearchParams(window.location.search);
    var from = snapWeek(params.get("from_week")), to = snapWeek(params.get("to_week"));
    if (from && to && from > to) return { from_week: null, to_week: null };
    return { from_week: from, to_week: to };
  }
  function sameFilter(a, b) { return a.from_week === b.from_week && a.to_week === b.to_week; }
  function inFilter(filter, cohort) {
    return (!filter.from_week || cohort >= filter.from_week) && (!filter.to_week || cohort <= filter.to_week);
  }
  function catalogFromCells(cells) {
    var seen = {};
    (cells || []).forEach(function (cell) {
      if (Number(cell.rel_week) === 0 && inFilter({ from_week: null, to_week: null }, cell.cohort_week)) seen[cell.cohort_week] = true;
    });
    return Object.keys(seen).sort();
  }
  function catalogRange(catalog, count) {
    var weeks = (catalog || []).map(snapWeek).filter(Boolean).sort();
    if (!weeks.length) return { from_week: null, to_week: null };
    var selected = weeks.slice(-count);
    return { from_week: selected[0], to_week: selected[selected.length - 1] };
  }
  function filterQuery(filter) {
    var params = new URLSearchParams();
    if (filter.from_week) params.set("from_week", filter.from_week);
    if (filter.to_week) params.set("to_week", filter.to_week);
    var query = params.toString();
    return query ? "?" + query : "";
  }
  function syncFilterUrl() {
    var url = new URL(window.location.href);
    if (weekFilter.from_week) url.searchParams.set("from_week", weekFilter.from_week); else url.searchParams.delete("from_week");
    if (weekFilter.to_week) url.searchParams.set("to_week", weekFilter.to_week); else url.searchParams.delete("to_week");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }
  function allowedFilter(filter, catalog) {
    if (sameFilter(filter, { from_week: null, to_week: null })) return true;
    if (sameFilter(filter, catalogRange(catalog, 8))) return true;
    if (sameFilter(filter, catalogRange(catalog, 12))) return true;
    return false;
  }
  function currentCatalog() {
    return (window.FIXTURES.SUMMARY && window.FIXTURES.SUMMARY.cohort_weeks) || catalogFromCells(window.FIXTURES.HEATMAP_FULL || window.FIXTURES.HEATMAP);
  }
  function coercePreset() {
    var catalog = currentCatalog();
    if (!catalog.length) return false;
    if (allowedFilter(weekFilter, catalog)) return false;
    weekFilter = { from_week: null, to_week: null };
    syncFilterUrl();
    return true;
  }
  function setFilterControls() {
    var catalog = currentCatalog();
    var last8 = catalogRange(catalog, 8), last12 = catalogRange(catalog, 12);
    var value = "all";
    if (last8.from_week && sameFilter(weekFilter, last8)) value = "last8";
    else if (last12.from_week && sameFilter(weekFilter, last12)) value = "last12";
    filterSelect.value = value;
    filterSelect.querySelector('option[value="last8"]').disabled = !catalog.length;
    filterSelect.querySelector('option[value="last12"]').disabled = !catalog.length;
  }

  function api(path) {
    return fetch(path, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    });
  }
  function fmtInt(n) {
    if (n == null || isNaN(Number(n))) return "—";
    return Number(n).toLocaleString("en-US");
  }
  function fmtPct(frac) {
    if (frac == null || isNaN(Number(frac))) return "—";
    return (Number(frac) * 100).toFixed(1) + "%";
  }

  var drawerCell = $("drawer-cell"), drawerCompany = $("drawer-company"), scrim = $("scrim");
  var sideNav = $("side-nav"), navToggle = $("nav-toggle");
  var hideTimers = {};
  var sideNavHideTimer = null;

  function openDrawer(el) {
    if (hideTimers[el.id]) { clearTimeout(hideTimers[el.id]); delete hideTimers[el.id]; }
    el.hidden = false;
    updateScrim();
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add("open"); }); });
  }
  function closeDrawer(el, after) {
    el.classList.remove("open");
    hideTimers[el.id] = setTimeout(function () {
      el.hidden = true;
      delete hideTimers[el.id];
      updateScrim();
      if (after) after();
    }, 200);
  }
  function closeAllDrawers(returnFocus) {
    if (!drawerCompany.hidden) closeDrawer(drawerCompany);
    if (!drawerCell.hidden) closeDrawer(drawerCell, function () {
      if (returnFocus && lastCellBtn) lastCellBtn.focus();
    });
  }
  function updateScrim() {
    var anyOpen = !drawerCell.hidden || !drawerCompany.hidden || !sideNav.hidden;
    scrim.hidden = !anyOpen;
    document.body.classList.toggle("no-scroll", anyOpen);
  }
  function openSideNav() {
    if (sideNavHideTimer) { clearTimeout(sideNavHideTimer); sideNavHideTimer = null; }
    sideNav.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
    navToggle.setAttribute("aria-label", "Close sections menu");
    updateScrim();
    requestAnimationFrame(function () { requestAnimationFrame(function () { sideNav.classList.add("open"); }); });
    $("side-nav-close").focus();
  }
  function closeSideNav(returnFocus) {
    if (sideNav.hidden) return;
    if (sideNavHideTimer) clearTimeout(sideNavHideTimer);
    sideNav.classList.remove("open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open sections menu");
    sideNavHideTimer = setTimeout(function () {
      sideNav.hidden = true;
      sideNavHideTimer = null;
      updateScrim();
      if (returnFocus) navToggle.focus();
    }, 260);
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function cohortLabel(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return String(iso);
    return Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1];
  }
  function shortDate(iso) {
    if (!iso) return "—";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    return Number(m[3]) + " " + MONTHS[Number(m[2]) - 1];
  }
  function pct(rate) { return (Number(rate) * 100).toFixed(1) + "%"; }
  function lvl(rate) {
    var r = Number(rate) || 0;
    if (r >= 0.8) return "lvl-5";
    if (r >= 0.5) return "lvl-4";
    if (r >= 0.35) return "lvl-3";
    if (r >= 0.2) return "lvl-2";
    return "lvl-1";
  }

  function setDown(down) {
    isDown = down;
    if (down) {
      apiError.hidden = false;
      appViews.hidden = true;
      closeAllDrawers(false);
      closeSideNav(false);
    } else {
      apiError.hidden = true;
      appViews.hidden = false;
    }
  }

  function filterCells(cells) {
    return (cells || []).filter(function (cell) { return inFilter(weekFilter, cell.cohort_week); });
  }
  function offlineSummary(summary, cells) {
    var copy = Object.assign({}, summary);
    var matureCutoff = new Date();
    matureCutoff.setUTCDate(matureCutoff.getUTCDate() - 63);
    var mature = (cells || []).filter(function (cell) {
      if (Number(cell.rel_week) !== 8 || !inFilter(weekFilter, cell.cohort_week)) return false;
      return new Date(cell.cohort_week + "T00:00:00Z") <= matureCutoff;
    }).sort(function (a, b) { return String(b.cohort_week).localeCompare(String(a.cohort_week)); });
    if (mature.length) {
      copy.week8_cohort_week = mature[0].cohort_week;
      copy.week8_cohort_size = mature[0].cohort_size;
      copy.week8_retained = mature[0].retained_count;
      copy.week8_retention = mature[0].rate;
    } else {
      copy.week8_cohort_week = null;
      copy.week8_cohort_size = 0;
      copy.week8_retained = 0;
      copy.week8_retention = null;
    }
    return copy;
  }
  function loadPage() {
    coercePreset();
    setFilterControls();
    if (offline) {
      var fullCells = window.FIXTURES.HEATMAP_FULL || window.FIXTURES.HEATMAP || [];
      window.FIXTURES.HEATMAP = filterCells(fullCells);
      window.FIXTURES.SUMMARY = offlineSummary(window.FIXTURES.SUMMARY_FULL || window.FIXTURES.SUMMARY, fullCells);
      setFilterControls();
      renderSummary();
      renderHeatmap();
      return;
    }
    api("/health").then(function () {
      return Promise.all([api("/api/summary" + filterQuery(weekFilter)), api("/api/heatmap" + filterQuery(weekFilter))]);
    }).then(function (pair) {
      window.FIXTURES.SUMMARY = pair[0];
      window.FIXTURES.HEATMAP = pair[1];
      if (coercePreset()) {
        loadPage();
        return;
      }
      setFilterControls();
      renderSummary();
      renderHeatmap();
    }).catch(function () {
      setDown(true);
    });
  }
  function setFilter(next) {
    weekFilter = next;
    syncFilterUrl();
    if (currentKey && !inFilter(weekFilter, currentKey.split("|")[0])) closeAllDrawers(false);
    loadPage();
  }

  function renderHeatmap() {
    var cells = window.FIXTURES.HEATMAP;
    heatmapBody.innerHTML = "";
    if (!cells || !cells.length) {
      heatmapEmpty.hidden = false;
      return;
    }
    heatmapEmpty.hidden = true;
    var byCohort = {};
    cells.forEach(function (c) {
      if (!byCohort[c.cohort_week]) byCohort[c.cohort_week] = {};
      byCohort[c.cohort_week][c.rel_week] = c;
    });
    var cohorts = Object.keys(byCohort).sort();
    cohorts.forEach(function (cw) {
      var tr = document.createElement("tr");
      var th = document.createElement("th");
      th.scope = "row"; th.textContent = cohortLabel(cw); th.title = cw;
      tr.appendChild(th);
      var first = byCohort[cw][0] || byCohort[cw][Object.keys(byCohort[cw])[0]];
      var n = document.createElement("td");
      n.className = "n-col"; n.textContent = first.cohort_size;
      tr.appendChild(n);
      for (var r = REL_MIN; r <= REL_MAX; r++) {
        var td = document.createElement("td");
        var cell = byCohort[cw][r];
        if (!cell) { td.className = "cell missing"; td.textContent = "—"; }
        else {
          td.className = "cell";
          var b = document.createElement("button");
          b.type = "button";
          b.className = "cell-btn " + lvl(cell.rate);
          b.dataset.cohort = cw; b.dataset.rel = String(r);
          b.setAttribute("aria-label", "Cohort " + cohortLabel(cw) + " Week " + r + ": " + cell.retained_count + " of " + cell.cohort_size);
          b.innerHTML = '<span class="count">' + esc(cell.retained_count) + "/" + esc(cell.cohort_size) + '</span>' +
            '<span class="rate">' + esc(pct(cell.rate)) + "</span>";
          b.addEventListener("click", function () {
            var prev = heatmapBody.querySelector(".cell-btn.selected");
            if (prev) prev.classList.remove("selected");
            this.classList.add("selected");
            lastCellBtn = this;
            loadCell(this.dataset.cohort, Number(this.dataset.rel));
          });
          td.appendChild(b);
        }
        tr.appendChild(td);
      }
      heatmapBody.appendChild(tr);
    });
  }

  function renderSummary() {
    var summary = window.FIXTURES && window.FIXTURES.SUMMARY;
    if (!summary) return;
    var activated = summary.activated;
    var clients = summary.client_companies;
    document.querySelector('[data-summary="activated"]').textContent = fmtInt(activated);
    var actSub = document.querySelector('[data-summary-sub="activated"]');
    if (actSub && clients != null) {
      actSub.textContent = "of " + fmtInt(clients) + " client companies.";
    }
    var rate = summary.activation_rate;
    document.querySelector('[data-summary="activation-rate"]').textContent =
      typeof rate === "string" ? rate : fmtPct(rate);
    var ttv = summary.median_ttv_hours;
    document.querySelector('[data-summary="median-ttv"]').textContent =
      ttv == null || ttv === "" ? "—" : (String(ttv).replace(/ h$/, "") + " h");
    var w8 = summary.week8_retention;
    document.querySelector('[data-summary="week8-retention"]').textContent =
      typeof w8 === "string" ? w8 : fmtPct(w8);
    var w8sub = document.querySelector('[data-summary-sub="week8"]');
    if (w8sub && summary.week8_cohort_week) {
      w8sub.textContent = "latest mature cohort · " + cohortLabel(summary.week8_cohort_week) +
        " · " + fmtInt(summary.week8_retained) + " of " + fmtInt(summary.week8_cohort_size) + ".";
    } else if (w8sub && summary.week8_retention == null) {
      w8sub.textContent = "no mature week-8 cohort in this range.";
    }
    var recon = summary.recon_among_activated;
    document.querySelector('[data-summary="recon-rate"]').textContent =
      typeof recon === "string" ? recon : fmtPct(recon);
  }

  function genCell(cw, rel, retained) {
    var users = [];
    for (var i = 0; i < retained; i++) {
      var n = i + 1;
      var companyNumbers = n === 12 ? [12, 13, 14] : [n];
      var companies = [];
      companyNumbers.forEach(function (companyNumber, companyIndex) {
        var hasRecon = companyNumber % 3 === 0;
        companies.push({
          company_id: "00000000-0000-4000-8000-" + String(100000000000 + (n * 10) + companyIndex),
          company_name: "Example Co " + companyNumber,
          signed_up_at: "2026-05-01", activated_at: cw, last_action_at: cw,
          lifetime_actions: 20 + companyNumber, active_weeks: 4, actions_per_active_week: 5.5, actions_that_week: 2 + (companyNumber % 5),
          upload_that_week: 1, txn_that_week: 1, sync_that_week: 1, recon_that_week: hasRecon ? 1 : 0,
          path_had_upload: true, path_had_ready: true, path_had_sync: true, path_had_recon: hasRecon,
          l4w_activity: { upload_count: 4, txn_count: 4, sync_count: 4, recon_count: hasRecon ? 4 : 0 },
          ttv_hours: 30 + companyNumber, value_events: ["Accounting Sync"]
        });
      });
      users.push({
        email: "user" + n + "@example.com", distinct_id: "u-" + cw + "-" + rel + "-" + n, user_id: "u-" + cw + "-" + rel + "-" + n,
        signed_up_at: "2026-05-01", last_action_at: cw,
        lifetime_actions: 20 + n, active_weeks: 4, actions_per_active_week: 5.5, actions_that_week: 2 + (n % 5),
        companies: companies
      });
    }
    var companyIds = {};
    users.forEach(function (u) {
      (u.companies || []).forEach(function (co) { companyIds[co.company_id] = true; });
    });
    return { cohort_week: cw, rel_week: rel, people_count: users.length, company_count: Object.keys(companyIds).length, median_actions_that_week: 4, users: users };
  }

  function getCell(cw, rel) {
    var key = cw + "|" + rel;
    if (window.FIXTURES.CELLS[key]) return window.FIXTURES.CELLS[key];
    var found = null;
    window.FIXTURES.HEATMAP.forEach(function (c) {
      if (c.cohort_week === cw && Number(c.rel_week) === Number(rel)) found = c;
    });
    var retained = found ? found.retained_count : 5;
    return genCell(cw, rel, retained);
  }

  function activityFor(co) {
    return {
      upload_count: Number(co.upload_that_week) || 0,
      txn_count: Number(co.txn_that_week) || 0,
      sync_count: Number(co.sync_that_week) || 0,
      recon_count: Number(co.recon_that_week) || 0
    };
  }

  function applyCellPayload(cw, rel, payload) {
    var selectedLabel = cohortLabel(cw) + " · Week " + rel;
    cellTitle.textContent = selectedLabel;
    search.value = "";
    selectedCompanyId = null;
    currentUsers = payload.users || [];
    peopleStatus.hidden = true;
    peopleDetail.hidden = false;
    peopleTitle.textContent = (payload.people_count || 0) + " users · " + (payload.company_count || 0) + " companies";
    var insights = [];
    if (payload.median_actions_that_week != null) insights.push("Median " + Number(payload.median_actions_that_week).toFixed(0) + " actions");
    var shares = [];
    if (payload.share_with_upload != null) shares.push("Upload " + Math.round(Number(payload.share_with_upload) * 100) + "%");
    if (payload.share_with_sync != null) shares.push("Sync " + Math.round(Number(payload.share_with_sync) * 100) + "%");
    if (payload.share_with_recon != null) shares.push("Recon " + Math.round(Number(payload.share_with_recon) * 100) + "%");
    if (shares.length) insights.push(shares.join(" · ") + " of companies");
    cellShares.textContent = insights.join(" · ");
    renderUsers(currentUsers);
    resetCompany();
    if (!drawerCompany.hidden) closeDrawer(drawerCompany);
    $("drawer-cell-close").focus();
  }

  function loadCell(cw, rel) {
    currentKey = cw + "|" + rel;
    var req = ++cellReq;
    peopleStatus.hidden = false;
    peopleStatus.textContent = "Loading…";
    peopleDetail.hidden = true;
    openDrawer(drawerCell);
    var done = offline
      ? Promise.resolve(getCell(cw, rel))
      : api("/api/heatmap/cell?cohort_week=" + encodeURIComponent(cw) + "&rel_week=" + encodeURIComponent(rel));
    done.then(function (payload) {
      if (req !== cellReq) return;
      applyCellPayload(cw, rel, payload);
    }).catch(function () {
      if (req !== cellReq) return;
      peopleStatus.textContent = "Cell unavailable. Check the API and try again.";
      peopleDetail.hidden = true;
    });
  }

  function filterUsers(q) {
    q = String(q || "").toLowerCase();
    if (!q) return currentUsers;
    return currentUsers.filter(function (u) {
      if (String(u.email || "").toLowerCase().indexOf(q) !== -1) return true;
      for (var i = 0; i < (u.companies || []).length; i++) {
        if (String(u.companies[i].company_name || "").toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    });
  }

  function renderUsers(users) {
    peopleList.innerHTML = "";
    if (!users.length) {
      var li = document.createElement("li");
      li.className = "user-block"; li.textContent = "No users match this filter.";
      peopleList.appendChild(li);
      return;
    }
    users.forEach(function (u) {
      var li = document.createElement("li");
      li.className = "user-block";
      var h = document.createElement("p");
      h.className = "user-label";
      var mail = document.createElement("span");
      mail.textContent = u.email || u.distinct_id;
      var cos = u.companies || [];
      var badge = document.createElement("span");
      badge.className = "co-badge";
      badge.textContent = cos.length + " " + (cos.length === 1 ? "company" : "companies");
      h.appendChild(mail); h.appendChild(badge);
      li.appendChild(h);
      var meta = document.createElement("p");
      meta.className = "user-meta";
      meta.textContent = "Signed up " + shortDate(u.signed_up_at) + " · " + u.lifetime_actions + " lifetime actions · " + u.active_weeks + " active weeks";
      li.appendChild(meta);
      if (cos.length > 1) {
        var groupLabel = document.createElement("p");
        groupLabel.className = "company-group-label";
        groupLabel.textContent = "Integrated companies";
        li.appendChild(groupLabel);
      }
      var ul = document.createElement("ul");
      ul.className = "company-list";
      cos.forEach(function (co, companyIndex) {
        var item = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button"; btn.className = "co-row";
        btn.dataset.companyId = co.company_id;
        btn.setAttribute("aria-label", "Open drill for " + (co.company_name || co.company_id) + ", company " + (companyIndex + 1) + " of " + cos.length + " for " + (u.email || u.distinct_id));
        var top = document.createElement("div");
        top.className = "co-top";
        var nm = document.createElement("span");
        nm.className = "co-name"; nm.textContent = co.company_name || co.company_id;
        top.appendChild(nm);
        if (co.ttv_hours != null) {
          var tv = document.createElement("span");
          tv.className = "co-ttv"; tv.textContent = "TTV " + Number(co.ttv_hours).toFixed(1) + " h";
          top.appendChild(tv);
        }
        btn.appendChild(top);
        var meta = document.createElement("div");
        meta.className = "co-meta";
        var integration = document.createElement("span");
        integration.textContent = "Integration " + shortDate(co.first_sync_at || co.activated_at || co.signed_up_at);
        var separator = document.createElement("span");
        separator.className = "co-meta-sep";
        separator.setAttribute("aria-hidden", "true");
        separator.textContent = "|";
        var activityLabel = document.createElement("span");
        activityLabel.textContent = "That week";
        meta.appendChild(integration); meta.appendChild(separator); meta.appendChild(activityLabel);
        btn.appendChild(meta);
        var activity = activityFor(co);
        var mix = document.createElement("div");
        mix.className = "co-mix";
        mix.setAttribute("aria-label", "That week event activity");
        [
          ["Upload", activity.upload_count],
          ["Transaction Ledger Updated", activity.txn_count],
          ["Accounting Sync", activity.sync_count],
          ["Recon Processed", activity.recon_count]
        ].forEach(function (event) {
          var eventItem = document.createElement("span");
          eventItem.className = "co-event";
          eventItem.textContent = event[0] + " " + event[1];
          mix.appendChild(eventItem);
        });
        btn.appendChild(mix);
        btn.addEventListener("click", function () {
          var prev = peopleList.querySelector(".co-row.selected");
          if (prev) prev.classList.remove("selected");
          this.classList.add("selected");
          selectedCompanyId = this.dataset.companyId;
          loadCompany(this.dataset.companyId);
        });
        if (String(co.company_id) === String(selectedCompanyId)) btn.classList.add("selected");
        item.appendChild(btn);
        ul.appendChild(item);
      });
      li.appendChild(ul);
      peopleList.appendChild(li);
    });
  }

  function resetCompany() {
    companyStatus.hidden = false;
    companyStatus.textContent = "No company chosen. Pick a company in the cell list.";
    companyDetail.hidden = true;
    timelineState = { companyId: null, offset: 0, total: null };
  }

  function findCompanyInCell(id) {
    for (var i = 0; i < currentUsers.length; i++) {
      var cos = currentUsers[i].companies || [];
      for (var j = 0; j < cos.length; j++) {
        if (String(cos[j].company_id) === String(id)) return cos[j];
      }
    }
    return null;
  }

  function showCompany(s) {
    companyStatus.hidden = true;
    companyDetail.hidden = false;
    companyName.textContent = s.company_name;
    var ttv = s.ttv_hours != null ? " (" + Number(s.ttv_hours).toFixed(1) + "h)" : "";
    companyPath.textContent = "Signup " + shortDate(s.signed_up_at) + " · Upload " + shortDate(s.first_upload_at) +
      " · AP/Txn ready " + shortDate(s.first_ready_at) + " · Sync " + shortDate(s.first_sync_at) + ttv +
      " · Recon " + shortDate(s.first_recon_at);
    companyStats.textContent = s.lifetime_actions + " lifetime actions · " + s.active_weeks + " active weeks";
    byWeekBody.innerHTML = "";
    (s.by_week || []).forEach(function (w) {
      var tr = document.createElement("tr");
      [w.week_start, w.action_count, w.upload_count, w.txn_count, w.sync_count, w.recon_count].forEach(function (v) {
        var td = document.createElement("td"); td.textContent = v; tr.appendChild(td);
      });
      byWeekBody.appendChild(tr);
    });
    byEventBody.innerHTML = "";
    (s.by_event || []).forEach(function (e) {
      var tr = document.createElement("tr");
      var a = document.createElement("td"); a.textContent = e.event_name;
      var b = document.createElement("td"); b.textContent = e.count;
      tr.appendChild(a); tr.appendChild(b);
      byEventBody.appendChild(tr);
    });
    timelineState = { companyId: s.company_id, offset: 0, total: null };
    loadTimelinePage(0);
    openDrawer(drawerCompany);
    $("drawer-company-close").focus();
  }

  function loadCompany(id) {
    var req = ++companyReq;
    companyStatus.hidden = false;
    companyStatus.textContent = "Loading…";
    companyDetail.hidden = true;
    openDrawer(drawerCompany);
    var done;
    if (offline) {
      done = Promise.resolve(window.FIXTURES.COMPANIES[id] || null);
    } else {
      done = api("/api/companies/" + encodeURIComponent(id) + "/summary");
    }
    done.then(function (s) {
      if (req !== companyReq) return;
      if (!s) {
        var c = findCompanyInCell(id);
        if (!c) {
          companyStatus.textContent = "Unknown company.";
          return;
        }
        s = {
          company_id: c.company_id, company_name: c.company_name,
          signed_up_at: c.signed_up_at, activated_at: c.activated_at,
          first_upload_at: c.signed_up_at, first_ready_at: c.activated_at, first_sync_at: c.activated_at,
          first_recon_at: c.path_had_recon ? c.last_action_at : null,
          last_action_at: c.last_action_at, lifetime_actions: c.lifetime_actions, active_weeks: c.active_weeks,
          actions_per_active_week: c.actions_per_active_week, ttv_hours: c.ttv_hours,
          path_had_upload: c.path_had_upload, path_had_ready: c.path_had_ready, path_had_sync: c.path_had_sync, path_had_recon: c.path_had_recon,
          by_week: [{ week_start: currentKey ? currentKey.split("|")[0] : "", action_count: c.actions_that_week, upload_count: c.upload_that_week, txn_count: c.txn_that_week, ap_count: 0, sync_count: c.sync_that_week, recon_count: c.recon_that_week }],
          by_event: [
            { event_name: "Transaction Ledger Updated", count: c.txn_that_week },
            { event_name: "Upload", count: c.upload_that_week },
            { event_name: "Accounting Sync", count: c.sync_that_week }
          ]
        };
      }
      showCompany(s);
    }).catch(function () {
      if (req !== companyReq) return;
      companyStatus.textContent = "Company unavailable. Check the API and try again.";
    });
  }

  function getTimeline(companyId, offset) {
    var key = companyId + "|" + offset;
    if (window.FIXTURES.TIMELINES[key]) return window.FIXTURES.TIMELINES[key];
    if (companyId === "22222222-2222-4222-8222-222222222222") {
      if (offset === 0) return { total: 104, limit: 100, offset: 0, events: [
        { event_time: "2026-06-29 17:52", event_name: "Recon Processed" },
        { event_time: "2026-06-29 17:20", event_name: "Accounting Sync" },
        { event_time: "2026-06-29 16:40", event_name: "Transaction Ledger Updated" },
        { event_time: "2026-06-29 16:12", event_name: "Upload" },
        { event_time: "2026-06-28 12:00", event_name: "Login" }
      ]};
      return { total: 104, limit: 100, offset: 100, events: [
        { event_time: "2026-04-14 10:02", event_name: "Accounting Sync" },
        { event_time: "2026-04-12 10:14", event_name: "Upload" }
      ]};
    }
    return { total: 3, limit: 100, offset: 0, events: [
      { event_time: "2026-06-29 12:00", event_name: "Accounting Sync" },
      { event_time: "2026-06-29 11:00", event_name: "Transaction Ledger Updated" },
      { event_time: "2026-06-29 10:30", event_name: "Upload" }
    ]};
  }

  function loadTimelinePage(offset) {
    var id = timelineState.companyId;
    if (!id) return;
    var done;
    if (offline) {
      done = Promise.resolve(getTimeline(id, offset));
    } else {
      done = api("/api/companies/" + encodeURIComponent(id) + "/timeline?limit=100&offset=" + encodeURIComponent(offset));
    }
    done.then(function (payload) {
      timelineState.offset = payload.offset;
      timelineState.total = payload.total;
      timelineList.innerHTML = "";
      payload.events.slice(0, 200).forEach(function (ev) {
        var li = document.createElement("li");
        var t = document.createElement("span"); t.className = "ev-time";
        t.textContent = String(ev.event_time || "").replace("T", " ").slice(0, 16);
        var n = document.createElement("span"); n.className = "ev-name"; n.textContent = ev.event_name;
        li.appendChild(t); li.appendChild(n);
        timelineList.appendChild(li);
      });
      timelineCount.textContent = "Showing " + payload.events.length + " of " + payload.total + " (offset " + payload.offset + ")";
      var hasOlder = payload.offset + payload.events.length < payload.total;
      timelineOlder.disabled = !hasOlder;
      timelineOlder.textContent = hasOlder ? "Older" : "No older events";
      timelineNewest.disabled = payload.offset === 0;
    }).catch(function () {
      timelineCount.textContent = "Timeline unavailable.";
    });
  }

  search.addEventListener("input", function () { renderUsers(filterUsers(search.value)); });
  timelineOlder.addEventListener("click", function () {
    if (timelineOlder.disabled) return;
    loadTimelinePage(timelineState.offset + 100);
  });
  timelineNewest.addEventListener("click", function () {
    if (timelineNewest.disabled) return;
    loadTimelinePage(0);
  });
  filterSelect.addEventListener("change", function () {
    if (filterSelect.value === "last8") setFilter(catalogRange(currentCatalog(), 8));
    else if (filterSelect.value === "last12") setFilter(catalogRange(currentCatalog(), 12));
    else setFilter({ from_week: null, to_week: null });
  });
  $("theme-toggle").addEventListener("click", function () {
    var el = document.documentElement;
    var dark = el.classList.toggle("dark");
    this.textContent = dark ? "Light" : "Dark";
    this.setAttribute("aria-pressed", dark ? "true" : "false");
  });
  $("drawer-cell-close").addEventListener("click", function () { closeAllDrawers(true); });
  $("drawer-company-close").addEventListener("click", function () {
    closeDrawer(drawerCompany, function () { $("drawer-cell-close").focus(); });
  });
  scrim.addEventListener("click", function () { closeAllDrawers(true); closeSideNav(false); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Tab" && !sideNav.hidden) {
      var focusable = sideNav.querySelectorAll("a[href], button:not([disabled])");
      if (focusable.length) {
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault(); last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault(); first.focus();
        }
      }
    }
    if (ev.key !== "Escape") return;
    if (!drawerCompany.hidden) closeDrawer(drawerCompany, function () { $("drawer-cell-close").focus(); });
    else if (!drawerCell.hidden) closeAllDrawers(true);
    else if (!sideNav.hidden) closeSideNav(true);
  });
  navToggle.addEventListener("click", function () {
    if (sideNav.hidden) openSideNav();
    else closeSideNav(true);
  });
  $("side-nav-close").addEventListener("click", function () { closeSideNav(true); });
  document.querySelectorAll(".side-item[href]").forEach(function (item) {
    item.addEventListener("click", function (ev) {
      ev.preventDefault();
      closeSideNav(true);
    });
  });

  document.addEventListener("DOMContentLoaded", function () {
    var params = new URLSearchParams(window.location.search);
    syncFilterUrl();
    setFilterControls();
    if (params.get("down") === "1") {
      setDown(true);
      return;
    }
    timelineNewest.disabled = true;
    timelineOlder.disabled = true;
    window.FIXTURES.SUMMARY_FULL = window.FIXTURES.SUMMARY;
    window.FIXTURES.HEATMAP_FULL = window.FIXTURES.HEATMAP;
    loadPage();
  });
})();
