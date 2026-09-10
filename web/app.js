/* Cohort Retention Explorer: reads only same-origin HTTP paths. */
(function () {
  "use strict";

  var REL_MIN = 0;
  var REL_MAX = 8;
  var TIMELINE_PAGE = 100;
  var TIMELINE_DOM_CAP = 200; // hard guard: never more than 200 timeline rows in the DOM

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var healthEl = document.getElementById("health");
  var heatmapTable = document.getElementById("heatmap");
  var heatmapBody = document.getElementById("heatmap-body");
  var heatmapStatus = document.getElementById("heatmap-status");
  var heatmapEmpty = document.getElementById("heatmap-empty");
  var heatmapExample = document.getElementById("heatmap-example");
  var cellStatus = document.getElementById("cell-status");
  var cellDetail = document.getElementById("cell-detail");
  var cellTitle = document.getElementById("cell-title");
  var cellInsight = document.getElementById("cell-insight");
  var cellFilter = document.getElementById("cell-filter");
  var cellUsers = document.getElementById("cell-users");
  var companyStatus = document.getElementById("company-status");
  var companyDetail = document.getElementById("company-detail");
  var companyTitle = document.getElementById("company-title");
  var companyPath = document.getElementById("company-path");
  var companyStats = document.getElementById("company-stats");
  var byWeekBody = document.getElementById("company-byweek-body");
  var byEventBody = document.getElementById("company-byevent-body");
  var timelineCount = document.getElementById("timeline-count");
  var timelineList = document.getElementById("timeline-list");
  var timelineOlder = document.getElementById("timeline-older");
  var timelineNewest = document.getElementById("timeline-newest");

  var selectedCellBtn = null;
  var currentUsers = [];
  var currentCohortWeek = null;
  var currentRelWeek = null;
  var timelineState = { companyId: null, companyLabel: null, offset: 0, total: null };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setStatus(el, message, isError) {
    el.textContent = message;
    el.classList.toggle("error", Boolean(isError));
  }

  function isoDate(value) {
    if (value == null || value === "") return null;
    var s = String(value);
    var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : s;
  }

  function cohortLabel(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return String(iso);
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    if (mo < 1 || mo > 12) return String(iso);
    return d + " " + MONTHS[mo - 1] + " " + y;
  }

  function num(value, fallback) {
    var n = Number(value);
    return isNaN(n) ? fallback : n;
  }

  function fixed1(value) {
    var n = Number(value);
    if (isNaN(n)) return "—";
    return n.toFixed(1);
  }

  function pctText(frac) {
    var n = Number(frac);
    if (frac == null || isNaN(n)) return "—";
    return (n * 100).toFixed(1) + "%";
  }

  function pct(rate) {
    if (rate == null || isNaN(Number(rate))) return "—";
    return (Number(rate) * 100).toFixed(1) + "%";
  }

  function cellRate(cell) {
    if (cell.rate != null && !isNaN(Number(cell.rate))) return Number(cell.rate);
    var cohort = Number(cell.cohort_size);
    var retained = Number(cell.retained_count);
    if (!cohort) return 0;
    return retained / cohort;
  }

  function shade(rate) {
    var r = Math.max(0, Math.min(1, Number(rate) || 0));
    var alpha = (0.06 + r * 0.5).toFixed(2);
    return "background-color: rgba(34, 120, 60, " + alpha + ");";
  }

  function ttvText(hours) {
    if (hours == null || hours === "" || isNaN(Number(hours))) return "—";
    return Number(hours).toFixed(1) + " h";
  }

  function tick(flag) {
    return flag ? "✓" : "—";
  }

  async function loadHealth() {
    try {
      var res = await fetch("/health", { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("status " + res.status);
      var data = await res.json();
      if (data && data.ok) {
        healthEl.textContent = "Service status: ok";
        healthEl.classList.remove("error");
      } else {
        throw new Error("unexpected response");
      }
    } catch (err) {
      healthEl.textContent = "Service status: unavailable (" + err.message + ")";
      healthEl.classList.add("error");
    }
  }

  async function loadHeatmap() {
    setStatus(heatmapStatus, "Loading heatmap…", false);
    heatmapEmpty.hidden = true;
    heatmapTable.hidden = true;
    heatmapExample.hidden = true;
    heatmapExample.textContent = "";
    try {
      var res = await fetch("/api/heatmap", { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("request failed with status " + res.status);
      var cells = await res.json();
      if (!Array.isArray(cells) || cells.length === 0) {
        setStatus(heatmapStatus, "", false);
        heatmapEmpty.hidden = false;
        return;
      }
      renderHeatmap(cells);
      setStatus(heatmapStatus, "Loaded " + cells.length + " cells.", false);
    } catch (err) {
      setStatus(heatmapStatus, "Could not load the heatmap: " + err.message + ". Check the service and reload.", true);
      heatmapEmpty.hidden = false;
      heatmapEmpty.textContent = "Heatmap unavailable. The load failed — check the service and reload.";
    }
  }

  function renderHeatmap(cells) {
    var byCohort = {};
    cells.forEach(function (c) {
      if (!c || !c.cohort_week) return;
      var key = isoDate(c.cohort_week);
      if (!byCohort[key]) byCohort[key] = {};
      var rel = Number(c.rel_week);
      if (rel >= REL_MIN && rel <= REL_MAX) byCohort[key][rel] = c;
    });
    var cohorts = Object.keys(byCohort).sort();
    heatmapBody.innerHTML = "";
    selectedCellBtn = null;
    cohorts.forEach(function (cohortWeek) {
      var rowCells = byCohort[cohortWeek];
      var first = null;
      for (var r = REL_MIN; r <= REL_MAX; r++) {
        if (rowCells[r]) { first = rowCells[r]; break; }
      }
      var cohortSize = first ? first.cohort_size : "—";
      var tr = document.createElement("tr");

      var th = document.createElement("th");
      th.scope = "row";
      th.textContent = cohortLabel(cohortWeek);
      th.title = cohortWeek;
      tr.appendChild(th);

      var nCell = document.createElement("td");
      nCell.className = "n-col";
      nCell.textContent = cohortSize;
      tr.appendChild(nCell);

      for (var rel = REL_MIN; rel <= REL_MAX; rel++) {
        var td = document.createElement("td");
        var cell = rowCells[rel];
        if (!cell) {
          td.className = "cell missing";
          td.textContent = "—";
        } else {
          var rate = cellRate(cell);
          td.className = "cell";
          td.setAttribute("style", shade(rate));
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "cell-btn";
          btn.dataset.cohortWeek = cohortWeek;
          btn.dataset.relWeek = String(rel);
          btn.title = "Cohort " + cohortWeek + ", week +" + rel + ": " + cell.retained_count + " of " + cell.cohort_size + " (" + pct(rate) + ")";
          btn.innerHTML =
            "<span class=\"count\">" + escapeHtml(cell.retained_count) + " / " + escapeHtml(cell.cohort_size) + "</span>" +
            "<span class=\"rate\">" + escapeHtml(pct(rate)) + "</span>";
          btn.addEventListener("click", function () {
            if (selectedCellBtn && selectedCellBtn !== this) selectedCellBtn.classList.remove("selected");
            selectedCellBtn = this;
            this.classList.add("selected");
            loadCell(this.dataset.cohortWeek, this.dataset.relWeek);
          });
          td.appendChild(btn);
        }
        tr.appendChild(td);
      }
      heatmapBody.appendChild(tr);
    });
    heatmapTable.hidden = false;
    renderWeek8Example(cells);
  }

  function renderWeek8Example(cells) {
    var w8 = cells.filter(function (c) {
      return c && Number(c.rel_week) === 8 && c.cohort_week;
    });
    if (w8.length === 0) {
      heatmapExample.hidden = true;
      heatmapExample.textContent = "";
      return;
    }
    w8.sort(function (a, b) {
      return String(a.cohort_week) < String(b.cohort_week) ? -1 : 1;
    });
    var last = w8[w8.length - 1];
    var iso = isoDate(last.cohort_week);
    heatmapExample.textContent =
      "Week-8 example: " + cohortLabel(iso) + " kept " +
      last.retained_count + " of " + last.cohort_size + " client companies.";
    heatmapExample.hidden = false;
  }

  function normalizeCellPayload(data) {
    // New shape: object with users[] + summary fields. Old shape: bare array.
    if (Array.isArray(data)) {
      return {
        users: data,
        company_count: null,
        people_count: data.length,
        median_actions_that_week: null,
        share_with_upload: null,
        share_with_sync: null,
        share_with_recon: null
      };
    }
    data = data || {};
    return {
      users: Array.isArray(data.users) ? data.users : [],
      company_count: data.company_count,
      people_count: data.people_count,
      median_actions_that_week: data.median_actions_that_week,
      share_with_upload: data.share_with_upload,
      share_with_sync: data.share_with_sync,
      share_with_recon: data.share_with_recon
    };
  }

  function companyCountFor(users) {
    var seen = {};
    var count = 0;
    users.forEach(function (u) {
      (u.companies || []).forEach(function (co) {
        var id = co && co.company_id ? String(co.company_id) : null;
        if (id && !seen[id]) { seen[id] = true; count++; }
      });
    });
    return count;
  }

  async function loadCell(cohortWeek, relWeek) {
    currentCohortWeek = cohortWeek;
    currentRelWeek = relWeek;
    setStatus(cellStatus, "Loading people for cohort " + cohortLabel(cohortWeek) + ", week +" + relWeek + "…", false);
    cellDetail.hidden = true;
    cellUsers.innerHTML = "";
    cellInsight.textContent = "";
    cellFilter.value = "";
    resetCompany("Pick a company under a person.");
    try {
      var url = "/api/heatmap/cell?cohort_week=" + encodeURIComponent(cohortWeek) + "&rel_week=" + encodeURIComponent(relWeek);
      var res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("request failed with status " + res.status);
      var payload = normalizeCellPayload(await res.json());
      var users = payload.users;
      if (users.length === 0) {
        currentUsers = [];
        setStatus(cellStatus, "No people in cohort " + cohortLabel(cohortWeek) + ", week +" + relWeek + ".", false);
        return;
      }
      setStatus(cellStatus, "", false);
      var m = payload.company_count != null ? num(payload.company_count, companyCountFor(users)) : companyCountFor(users);
      var n = payload.people_count != null ? num(payload.people_count, users.length) : users.length;
      cellTitle.textContent =
        "Cohort " + cohortLabel(cohortWeek) + " · week +" + relWeek + " — " +
        m + " companies · " + n + " people";
      cellInsight.textContent = cellInsightText(payload);
      users.sort(function (a, b) {
        var diff = num(b.actions_that_week, 0) - num(a.actions_that_week, 0);
        if (diff !== 0) return diff;
        return String(a.email || a.distinct_id || "").localeCompare(String(b.email || b.distinct_id || ""));
      });
      currentUsers = users;
      renderUsers(filterUsers(users, ""));
      cellDetail.hidden = false;
    } catch (err) {
      setStatus(cellStatus, "Could not load people: " + err.message + ".", true);
    }
  }

  function cellInsightText(payload) {
    var parts = [];
    if (payload.median_actions_that_week != null && !isNaN(Number(payload.median_actions_that_week))) {
      parts.push("median " + fixed1(payload.median_actions_that_week) + " actions that week");
    }
    var mix = [];
    if (payload.share_with_upload != null && !isNaN(Number(payload.share_with_upload))) {
      mix.push(pctText(payload.share_with_upload) + " with upload");
    }
    if (payload.share_with_sync != null && !isNaN(Number(payload.share_with_sync))) {
      mix.push(pctText(payload.share_with_sync) + " with sync");
    }
    if (payload.share_with_recon != null && !isNaN(Number(payload.share_with_recon))) {
      mix.push(pctText(payload.share_with_recon) + " with recon");
    }
    if (mix.length > 0) parts.push(mix.join(" · "));
    return parts.join("; ") + (parts.length ? "." : "");
  }

  function filterUsers(users, q) {
    q = String(q || "").toLowerCase();
    if (!q) return users;
    return users.filter(function (u) {
      var email = String(u.email || "").toLowerCase();
      if (email.indexOf(q) !== -1) return true;
      var cos = u.companies || [];
      for (var i = 0; i < cos.length; i++) {
        if (String(cos[i].company_name || "").toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    });
  }

  function renderUsers(users) {
    cellUsers.innerHTML = "";
    if (users.length === 0) {
      var empty = document.createElement("li");
      empty.className = "user-block";
      empty.textContent = "No people match this filter.";
      cellUsers.appendChild(empty);
      return;
    }
    users.forEach(function (user) {
      var li = document.createElement("li");
      li.className = "user-block";
      var heading = document.createElement("h3");
      heading.className = "user-label";
      heading.textContent = user.email || user.distinct_id || "(no user id)";
      li.appendChild(heading);
      var meta = document.createElement("p");
      meta.className = "user-meta";
      meta.textContent =
        "signed up " + (isoDate(user.signed_up_at) || "—") +
        " · " + num(user.lifetime_actions, 0) + " lifetime actions" +
        " · " + num(user.active_weeks, 0) + " active weeks" +
        " · " + fixed1(user.actions_per_active_week) + " per active week" +
        " · " + num(user.actions_that_week, 0) + " that week";
      li.appendChild(meta);
      var cos = document.createElement("ul");
      cos.className = "company-list";
      (user.companies || []).forEach(function (co) {
        var item = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "link-btn company-name";
        btn.textContent = co.company_name || co.company_id;
        btn.dataset.companyId = co.company_id;
        btn.dataset.companyLabel = co.company_name || co.company_id;
        btn.addEventListener("click", function () {
          loadCompany(this.dataset.companyId, this.dataset.companyLabel);
        });
        item.appendChild(btn);
        var uuid = document.createElement("div");
        uuid.className = "company-uuid";
        uuid.textContent = co.company_name ? co.company_id : "";
        if (uuid.textContent) item.appendChild(uuid);
        var detail = document.createElement("div");
        detail.className = "company-meta";
        var veil = Array.isArray(co.value_events) ? co.value_events.join(", ") : "";
        detail.textContent =
          "signed up " + (isoDate(co.signed_up_at) || "—") +
          " · activated " + (isoDate(co.activated_at) || "—") +
          " · TTV " + ttvText(co.ttv_hours) +
          " · last action " + (isoDate(co.last_action_at) || "—") +
          " · " + num(co.lifetime_actions, 0) + " lifetime actions" +
          " · " + num(co.active_weeks, 0) + " active weeks" +
          " · that week " + num(co.actions_that_week, 0) +
          " (upload " + num(co.upload_that_week, 0) +
          " / txn " + num(co.txn_that_week, 0) +
          " / sync " + num(co.sync_that_week, 0) +
          " / recon " + num(co.recon_that_week, 0) + ")" +
          " · path upload " + tick(co.path_had_upload) +
          " ready " + tick(co.path_had_ready) +
          " sync " + tick(co.path_had_sync) +
          " recon " + tick(co.path_had_recon) +
          (veil ? " · " + veil : "");
        item.appendChild(detail);
        cos.appendChild(item);
      });
      li.appendChild(cos);
      cellUsers.appendChild(li);
    });
  }

  function resetCompany(message) {
    companyDetail.hidden = true;
    companyTitle.textContent = "";
    companyPath.textContent = "";
    companyStats.textContent = "";
    byWeekBody.innerHTML = "";
    byEventBody.innerHTML = "";
    timelineCount.textContent = "";
    timelineList.innerHTML = "";
    timelineOlder.hidden = true;
    timelineNewest.hidden = true;
    timelineState = { companyId: null, companyLabel: null, offset: 0, total: null };
    setStatus(companyStatus, message, false);
  }

  async function loadCompany(companyId, companyLabel) {
    setStatus(companyStatus, "Loading company " + (companyLabel || companyId) + "…", false);
    companyDetail.hidden = true;
    timelineState = { companyId: companyId, companyLabel: companyLabel || companyId, offset: 0, total: null };
    try {
      var res = await fetch("/api/companies/" + encodeURIComponent(companyId) + "/summary", {
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) throw new Error("request failed with status " + res.status);
      var s = await res.json();
      setStatus(companyStatus, "", false);
      renderCompanySummary(s || {}, companyLabel || companyId);
      companyDetail.hidden = false;
      await loadTimelinePage(0);
    } catch (err) {
      setStatus(companyStatus, "Could not load company: " + err.message + ".", true);
    }
  }

  function renderCompanySummary(s, fallbackLabel) {
    var label = s.company_name || fallbackLabel || s.company_id;
    companyTitle.textContent = label + " — " + (s.company_id || "");
    var step = function (v) { return isoDate(v) || "—"; };
    companyPath.textContent =
      "signed up " + step(s.signed_up_at) +
      " → first upload " + step(s.first_upload_at) +
      " → first ready " + step(s.first_ready_at) +
      " → first sync " + step(s.first_sync_at) +
      " → first recon " + step(s.first_recon_at);
    companyStats.textContent =
      num(s.lifetime_actions, 0) + " lifetime actions" +
      " · " + num(s.active_weeks, 0) + " active weeks" +
      " · " + fixed1(s.actions_per_active_week) + " per active week" +
      " · last action " + (isoDate(s.last_action_at) || "—") +
      " · TTV " + ttvText(s.ttv_hours);

    byWeekBody.innerHTML = "";
    var weeks = Array.isArray(s.by_week) ? s.by_week : [];
    if (weeks.length === 0) {
      var wtr = document.createElement("tr");
      var wtd = document.createElement("td");
      wtd.colSpan = 6;
      wtd.textContent = "No weekly action data.";
      wtr.appendChild(wtd);
      byWeekBody.appendChild(wtr);
    } else {
      weeks.forEach(function (w) {
        var tr = document.createElement("tr");
        var cells = [
          isoDate(w.week_start) || "—",
          num(w.action_count, 0),
          num(w.upload_count, 0),
          num(w.txn_count, 0),
          num(w.sync_count, 0),
          num(w.recon_count, 0)
        ];
        cells.forEach(function (v) {
          var td = document.createElement("td");
          td.textContent = v;
          tr.appendChild(td);
        });
        byWeekBody.appendChild(tr);
      });
    }

    byEventBody.innerHTML = "";
    var evts = Array.isArray(s.by_event) ? s.by_event : [];
    if (evts.length === 0) {
      var etr = document.createElement("tr");
      var etd = document.createElement("td");
      etd.colSpan = 2;
      etd.textContent = "No action events.";
      etr.appendChild(etd);
      byEventBody.appendChild(etr);
    } else {
      evts.forEach(function (e) {
        var tr = document.createElement("tr");
        var name = document.createElement("td");
        name.textContent = e.event_name;
        var count = document.createElement("td");
        count.textContent = num(e.count, 0);
        tr.appendChild(name);
        tr.appendChild(count);
        byEventBody.appendChild(tr);
      });
    }
  }

  function normalizeTimelinePayload(data) {
    // New shape: {total, limit, offset, events:[{event_time, event_name}]}.
    // Old shape: bare array.
    if (Array.isArray(data)) return { events: data, total: data.length, offset: 0 };
    data = data || {};
    return {
      events: Array.isArray(data.events) ? data.events : [],
      total: data.total != null ? num(data.total, null) : null,
      offset: num(data.offset, 0)
    };
  }

  async function loadTimelinePage(offset) {
    var id = timelineState.companyId;
    if (!id) return;
    timelineCount.textContent = "Loading timeline…";
    timelineOlder.disabled = true;
    try {
      var url = "/api/companies/" + encodeURIComponent(id) +
        "/timeline?limit=" + TIMELINE_PAGE + "&offset=" + offset;
      var res = await fetch(url, { headers: { "Accept": "application/json" } });
      if (!res.ok) throw new Error("request failed with status " + res.status);
      var raw = await res.json();
      var legacyShape = Array.isArray(raw);
      var payload = normalizeTimelinePayload(raw);
      var events = payload.events;
      // Old flat-array shape predates the newest-first contract: sort newest first.
      // New {events} shape is already newest-first; keep API order.
      if (legacyShape) {
        events.sort(function (a, b) {
          return String(a.event_time) < String(b.event_time) ? 1 : -1;
        });
      }
      // Legacy array shape carries no total (stays null); paging then
      // continues while a full page comes back.
      timelineState.total = payload.total;
      timelineState.offset = offset;
      renderTimelinePage(events);
    } catch (err) {
      timelineCount.textContent = "Could not load timeline: " + err.message + ".";
      timelineOlder.disabled = false;
    }
  }

  function renderTimelinePage(events) {
    // Guard: replace the page, never append; cap DOM nodes at TIMELINE_DOM_CAP.
    timelineList.innerHTML = "";
    var page = events.slice(0, TIMELINE_DOM_CAP);
    page.forEach(function (ev) {
      var li = document.createElement("li");
      var time = document.createElement("span");
      time.className = "ev-time";
      time.textContent = ev.event_time;
      var name = document.createElement("span");
      name.className = "ev-name";
      name.textContent = ev.event_name;
      li.appendChild(time);
      li.appendChild(document.createTextNode(" — "));
      li.appendChild(name);
      timelineList.appendChild(li);
    });
    var total = timelineState.total;
    var offset = timelineState.offset;
    var shown = page.length;
    var totalCopy = total != null ? " of " + total + " total" : "";
    var capNote = "";
    if (events.length > TIMELINE_DOM_CAP) {
      capNote = " (page trimmed to " + TIMELINE_DOM_CAP + " rows in the DOM)";
    }
    if (shown === 0 && (total == null || total === 0)) {
      timelineCount.textContent = "No events for this company.";
    } else {
      timelineCount.textContent =
        "Showing newest " + shown + " events" + totalCopy +
        " (offset " + offset + ")" + capNote +
        ". At most " + TIMELINE_DOM_CAP + " rows are ever shown at once.";
    }
    var hasOlder = total != null
      ? (offset + shown < total)
      : (shown >= TIMELINE_PAGE);
    timelineOlder.hidden = false;
    timelineNewest.hidden = false;
    timelineNewest.disabled = offset === 0;
    timelineOlder.disabled = !hasOlder;
    timelineOlder.textContent = hasOlder ? "Older" : "No older events";
  }

  cellFilter.addEventListener("input", function () {
    renderUsers(filterUsers(currentUsers, cellFilter.value));
  });

  timelineOlder.addEventListener("click", function () {
    if (timelineOlder.disabled) return;
    loadTimelinePage(timelineState.offset + TIMELINE_PAGE);
  });

  timelineNewest.addEventListener("click", function () {
    if (timelineNewest.disabled) return;
    loadTimelinePage(0);
  });

  document.addEventListener("DOMContentLoaded", function () {
    loadHealth();
    loadHeatmap();
  });
})();

