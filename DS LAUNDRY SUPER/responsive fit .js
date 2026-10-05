/* DS Laundry — shared helpers: responsive fit + "Back to login".
 * Load in <head> of login.html, index.html and admin.html. */
(function () {
  var root = document.documentElement;

  function apply() {
    var touch     = (navigator.maxTouchPoints || 0) > 0 || 'ontouchstart' in window;
    var shortSide = Math.min(screen.width || 9999, screen.height || 9999);
    // A real phone / small tablet, even when the browser is in "Desktop site"
    // mode and claims a ~980px-wide viewport.
    var phoneHw   = touch && shortSide <= 820;
    var narrow    = window.innerWidth <= 768;

    root.classList.toggle('compact', narrow || phoneHw);
    root.classList.toggle('forced-desktop', phoneHw && window.innerWidth > 820);

    // Ask the browser to use the device width again (honoured by most browsers;
    // some ignore it in Desktop-site mode — the .compact layout covers that case).
    if (phoneHw && window.innerWidth > 820) {
      var m = document.querySelector('meta[name="viewport"]');
      if (m) m.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
    }
  }
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
})();

/* Back button: always lands on the login page. The session is signed out first,
 * otherwise login.html would immediately bounce a signed-in user back to their
 * dashboard. location.replace keeps the dashboard out of the history stack. */
function goBackToLogin() {
  var go = function () { window.location.replace('login.html'); };
  try {
    var p = window.firebase && firebase.auth && firebase.auth().signOut();
    if (p && typeof p.then === 'function') { p.then(go, go); return; }
  } catch (e) {}
  go();
}