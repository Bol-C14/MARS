// Language switch (shared with the IDE) and the small stepping demo.
(function () {
  var root = document.documentElement;
  document.querySelectorAll("[data-switch-lang]").forEach(function (b) {
    b.addEventListener("click", function () {
      var next = root.dataset.lang === "zh-CN" ? "en" : "zh-CN";
      root.lang = next;
      root.dataset.lang = next;
      try { localStorage.setItem("mars-trace:language", next); } catch (e) {}
      if (window.umami) try { window.umami.track("language", { to: next }); } catch (e) {}
    });
  });

  var lines = Array.prototype.slice.call(document.querySelectorAll(".trace-lines li"));
  var counter = document.getElementById("trace-n");
  var keys = document.querySelectorAll(".trace-controls .key");
  function show(n) {
    lines.forEach(function (li, i) {
      li.classList.toggle("done", i < n);
      li.classList.toggle("now", i === n);
    });
    if (counter) counter.textContent = String(n + 1);
  }
  // Forward through the program, back two steps, forward again: what
  // the IDE lets a student do.
  var script = [0, 1, 2, 3, 4, 3, 2, 3, 4];
  var at = 3;
  show(script[at]);
  if (!lines.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  setInterval(function () {
    if (document.hidden) return;
    var prev = script[at];
    at = (at + 1) % script.length;
    var back = script[at] < prev;
    keys.forEach(function (k, i) { k.classList.toggle("pressed", back ? i === 0 : i === 1); });
    show(script[at]);
  }, 1300);
})();
