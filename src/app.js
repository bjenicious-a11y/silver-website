// Live jewellery price calculator. Works without this script too (server-rendered defaults).
(function () {
  'use strict';
  var fmt = function (n) {
    return '₹' + Math.round(n).toLocaleString('en-IN');
  };
  var num = function (el, fallback) {
    var v = parseFloat(el && el.value);
    return isFinite(v) && v >= 0 ? v : fallback;
  };
  document.querySelectorAll('[data-calc]').forEach(function (root) {
    var rate999 = parseFloat(root.getAttribute('data-rate999'));
    if (!isFinite(rate999)) return;
    var inGrams = root.querySelector('[data-in="grams"]');
    var inPurity = root.querySelector('[data-in="purity"]');
    var inMaking = root.querySelector('[data-in="making"]');
    var out = function (k) { return root.querySelector('[data-out="' + k + '"]'); };
    function update() {
      var grams = num(inGrams, 0);
      var purity = num(inPurity, 0.925);
      var making = Math.min(num(inMaking, 0), 100);
      var metal = rate999 * purity * grams;
      var mk = metal * making / 100;
      var gst = (metal + mk) * 0.03;
      out('metal').textContent = fmt(metal);
      out('making').textContent = fmt(mk);
      out('gst').textContent = fmt(gst);
      out('total').textContent = fmt(metal + mk + gst);
    }
    [inGrams, inPurity, inMaking].forEach(function (el) {
      if (el) el.addEventListener('input', update);
    });
    update();
  });
})();
