(function () {
  var out = {
    error: null,
    viewport: null,
    elements: [],
    horizontalScroll: {},
    reachability: {},
    pushedOut: [],
  };

  function label(el) {
    var t = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
    return t.slice(0, 34);
  }
  function round(r) {
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function shown(el) {
    if (!el || el.getClientRects().length === 0) return false;
    var s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function byText(text, scope) {
    var list = Array.prototype.slice.call((scope || document).querySelectorAll("button"));
    for (var i = 0; i < list.length; i++) {
      if ((list[i].textContent || "").indexOf(text) >= 0) return list[i];
    }
    return null;
  }
  function desc(el) {
    return { tag: el.tagName.toLowerCase(), id: el.id || null, label: label(el) };
  }

  function measure(el, name, kind) {
    if (!el) { out.elements.push({ name: name, kind: kind, found: false }); return; }
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    out.elements.push({
      name: name, kind: kind, found: true,
      rect: round(r),
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      height: Math.round(r.height),
      width: Math.round(r.width),
      inView: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
      insideViewportX: r.left >= -1 && r.right <= window.innerWidth + 1,
      insideViewportY: r.top >= -1 && r.bottom <= window.innerHeight + 1,
      desc: desc(el),
    });
  }

  function controls(scope) {
    var list = Array.prototype.slice.call(
      (scope || document).querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])'));
    return list.filter(function (el) { return shown(el) && !el.disabled; });
  }
  function scrollerIn(el, scope) {
    for (var p = el.parentElement; p; p = p.parentElement) {
      var st = getComputedStyle(p);
      if ((st.overflowY === "auto" || st.overflowY === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
      if (p === scope) break;
    }
    return null;
  }
  function cutByHiddenBox(el, scope) {
    var r = el.getBoundingClientRect();
    for (var p = el.parentElement; p; p = p.parentElement) {
      var st = getComputedStyle(p);
      var clips = /hidden|clip/.test(st.overflow + " " + st.overflowX + " " + st.overflowY);
      var scrolls = /(auto|scroll)/.test(st.overflowX + " " + st.overflowY);
      var clipped = p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1;
      if (clips && !scrolls && clipped) {
        var b = p.getBoundingClientRect();
        if (r.left < b.left - 1 || r.top < b.top - 1 || r.right > b.right + 1 || r.bottom > b.bottom + 1)
          return (p.className || p.tagName).toString().slice(0, 60);
      }
      if (p === scope) break;
    }
    return null;
  }

  function reachability(scope) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var list = controls(scope), problems = [], belowFold = 0;
    for (var i = 0; i < list.length; i++) {
      var el = list[i], r = el.getBoundingClientRect(), what = label(el);
      if (r.width < 1 || r.height < 1) { problems.push({ why: "zero-size", what: what }); continue; }
      if (r.left < -1 || r.right > vw + 1) { problems.push({ why: "off-screen-x", what: what, rect: round(r), viewportW: vw }); continue; }
      var cut = cutByHiddenBox(el, scope);
      if (cut) { problems.push({ why: "cut-by-hidden-box", what: what, rect: round(r), box: cut }); continue; }
      if (r.top < -1 || r.bottom > vh + 1) {
        if (scrollerIn(el, scope)) belowFold++;
        else problems.push({ why: "off-screen-y-no-scroll", what: what, rect: round(r), viewportH: vh });
      }
    }
    return { checked: list.length, problems: problems, belowFoldInScroll: belowFold };
  }

  function horizontalScroll() {
    var doc = document.documentElement;
    var offenders = [];
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!shown(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        var s = getComputedStyle(el);
        offenders.push({
          what: label(el) || (el.className || el.tagName).toString().slice(0, 40),
          scrollW: el.scrollWidth, clientW: el.clientWidth,
          overflowX: s.overflowX,
          scrollable: /auto|scroll/.test(s.overflowX),
        });
      }
    }
    var docOverflow = (doc.scrollWidth > doc.clientWidth + 1) || (document.body && document.body.scrollWidth > doc.clientWidth + 1);
    // boxes that actually let the finger/trackpad pan sideways
    var pannable = offenders.filter(function (o) { return o.scrollable; });
    return {
      docScrollW: doc.scrollWidth, docClientW: doc.clientWidth,
      documentOverflows: docOverflow,
      horizontallyScrollableBoxes: pannable.length,
      offenders: offenders.slice(0, 20),
    };
  }

  // Every visible control / heading that is NOT inside the viewport, with the
  // reason it may still be reachable (there is a scroller) or not.
  function offViewport(scope) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var nodes = Array.prototype.slice.call(
      (scope || document).querySelectorAll('h1,h2,h3,button,a[href],input,select,textarea,[role="switch"]'));
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!shown(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      var offX = r.left < -1 || r.right > vw + 1;
      var below = r.top > vh + 1;
      var above = r.bottom < -1;
      if (!offX && !below && !above) continue;
      list.push({
        tag: el.tagName.toLowerCase(),
        what: label(el).slice(0, 26),
        dir: offX ? "x" : (below ? "below" : "above"),
        rect: round(r),
        scrollableAncestor: !!scrollerIn(el, scope),
      });
    }
    return list.slice(0, 40);
  }

  window.addEventListener("load", function () {
    void (async function () {
      try {
        for (var i = 0; i < 8; i++) await null;
        out.viewport = {
          innerW: window.innerWidth, innerH: window.innerHeight,
          dpr: window.devicePixelRatio,
          clientW: document.documentElement.clientWidth,
          clientH: document.documentElement.clientHeight,
          docScrollW: document.documentElement.scrollWidth,
        };
        measure(document.querySelector("h1"), "h1 问候标题", "heading");
        var intro = document.querySelector("h1 + p") || document.querySelectorAll("p")[0];
        measure(intro, "p 引导正文", "body");
        var card = document.querySelector('button[aria-label*="。"]');
        measure(card, "第一张任务卡（整块按钮）", "button");
        if (card) {
          var spans = card.querySelectorAll("span");
          if (spans[0]) measure(spans[0], "卡标题 span", "heading");
          if (spans[1]) measure(spans[1], "卡示例 span", "body");
        }
        measure(document.getElementById("cante-say"), "输入框 #cante-say", "input");
        measure(byText("开始处理"), "按钮「开始处理」", "button");
        measure(byText("看看能做什么"), "按钮「看看能做什么」", "button");
        measure(byText("打开我做的结果"), "按钮「打开我做的结果」", "button");
        measure(byText("历史"), "按钮「历史」", "button");
        measure(byText("隐私"), "按钮「隐私」", "button");
        measure(document.querySelector(".shrink-0.border-t"), "底部输入区容器", "container");

        out.horizontalScroll = horizontalScroll();
        var scan = reachability(document);
        out.reachability = scan;
        out.pushedOut = scan.problems.map(function (p) {
          return { why: p.why, what: p.what, rect: p.rect || null };
        });
        out.offViewport = offViewport(document);
        // tap-target floor (§ product rule: buttons >= 44 CSS px tall)
        var btns = controls(document).filter(function (el) { return el.tagName === "BUTTON"; });
        var short = [];
        for (var b = 0; b < btns.length; b++) {
          var h = Math.round(btns[b].getBoundingClientRect().height);
          if (h < 44) short.push({ what: label(btns[b]).slice(0, 26), h: h });
        }
        out.buttonFloor = { total: btns.length, below44: short.length, offenders: short };
        // body-text floor
        var bodyish = [];
        var all = document.querySelectorAll("p,span,label,dd,dt,li");
        for (var q = 0; q < all.length; q++) {
          if (!shown(all[q])) continue;
          var txt = (all[q].textContent || "").trim();
          if (!txt) continue;
          var f = parseFloat(getComputedStyle(all[q]).fontSize);
          if (f < 16) bodyish.push({ what: txt.slice(0, 20), px: f });
        }
        out.bodyFloor = { count: bodyish.length, offenders: bodyish.slice(0, 15) };

        // three body-text samples and three button samples, whatever they are
        out.bodySamples = [];
        var ps = Array.prototype.slice.call(document.querySelectorAll("p,span,label,dd"));
        for (var s = 0; s < ps.length && out.bodySamples.length < 3; s++) {
          if (!shown(ps[s])) continue;
          if (ps[s].closest("header")) continue;
          var t = (ps[s].textContent || "").trim();
          if (t.length < 6 || t === "Cante") continue;
          out.bodySamples.push({ what: t.slice(0, 24), font: getComputedStyle(ps[s]).fontSize, h: Math.round(ps[s].getBoundingClientRect().height) });
        }
        out.buttonSamples = [];
        var b2 = controls(document).filter(function (el) { return el.tagName === "BUTTON"; });
        var seenLabels = {};
        for (var s2 = 0; s2 < b2.length && out.buttonSamples.length < 3; s2++) {
          var lb = label(b2[s2]).slice(0, 22);
          if (seenLabels[lb]) continue;
          var r2 = b2[s2].getBoundingClientRect();
          if (r2.width < 90) continue;
          seenLabels[lb] = 1;
          out.buttonSamples.push({ what: lb, h: Math.round(r2.height), w: Math.round(r2.width), font: getComputedStyle(b2[s2]).fontSize });
        }

        // vertical budget: how much of the screen the fixed footer eats, and how
        // many cards she can actually see without scrolling.
        var cards = Array.prototype.slice.call(document.querySelectorAll('button[aria-label*="。"]'));
        var scroller = cards.length ? scrollerIn(cards[0], document) : null;
        var footer = document.querySelector(".shrink-0.border-t");
        var header = document.querySelector("header") || document.querySelector("h1") && document.querySelector("h1").closest("div");
        var vh = window.innerHeight;
        var scH = scroller ? scroller.clientHeight : null;
        var fullyInScroller = 0, fullyInViewport = 0, partlyVisible = 0;
        for (var c = 0; c < cards.length; c++) {
          var cr = cards[c].getBoundingClientRect();
          if (scroller) {
            var sr = scroller.getBoundingClientRect();
            if (cr.top >= sr.top - 1 && cr.bottom <= sr.bottom + 1 && cr.bottom > sr.top + 1) fullyInScroller++;
          }
          if (cr.top >= -1 && cr.bottom <= vh + 1 && cr.left >= -1 && cr.right <= window.innerWidth + 1) fullyInViewport++;
          var visibleH = Math.min(cr.bottom, vh) - Math.max(cr.top, 0);
          if (visibleH > 8 && cr.top < vh) partlyVisible++;
        }
        // can she scroll the last card fully into view?
        var lastCardReachable = null;
        if (scroller && cards.length) {
          var keep = scroller.scrollTop;
          var sr2 = scroller.getBoundingClientRect();
          function alignAndCheck(card) {
            var r = card.getBoundingClientRect();
            var delta = r.top - sr2.top;
            scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
            var nr = card.getBoundingClientRect();
            return nr.top >= sr2.top - 1 && nr.bottom <= sr2.bottom + 1 && nr.bottom > sr2.top + 1;
          }
          out.scrollToFirstCard = alignAndCheck(cards[0]);
          scroller.scrollTop = scroller.scrollHeight;
          var lr = cards[cards.length - 1].getBoundingClientRect();
          lastCardReachable = lr.top >= sr2.top - 1 && lr.bottom <= sr2.bottom + 1;
          out.scrollToLastCard = lastCardReachable;
          scroller.scrollTop = keep;
        }
        out.vertical = {
          viewportH: vh,
          scrollerClientH: scH,
          scrollerScrollH: scroller ? scroller.scrollHeight : null,
          footerH: footer ? Math.round(footer.getBoundingClientRect().height) : null,
          footerPct: footer ? Math.round((footer.getBoundingClientRect().height / vh) * 100) : null,
          headerH: header ? Math.round(header.getBoundingClientRect().height) : null,
          totalCards: cards.length,
          cardsFullyInScroller: fullyInScroller,
          cardsFullyInViewport: fullyInViewport,
          cardsPartlyVisible: partlyVisible,
          scrollToFirstCard: out.scrollToFirstCard,
          scrollToLastCard: out.scrollToLastCard,
        };
      } catch (e) {
        out.error = String((e && e.stack) || e);
      }
      var pre = document.createElement("pre");
      pre.id = "zoom-report";
      pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
    })();
  });
})();
