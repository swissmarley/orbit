// The desktop shell's own page: "Starting Orbit…" until the Rust side has a
// sign-in link from `orbit app --json`, or why it could not get one (passed
// as ?error=…&hint=…). Text only, never HTML.
const params = new URLSearchParams(window.location.search);
const error = params.get('error');
if (error) {
  document.getElementById('status').hidden = true;
  document.getElementById('problem').hidden = false;
  document.getElementById('message').textContent = error;
  document.getElementById('hint').textContent = params.get('hint') ?? '';
}
