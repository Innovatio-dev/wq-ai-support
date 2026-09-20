// Keep ?next= on the form action and show the error state. (External file: the CSP forbids inline scripts.)
const p = new URLSearchParams(location.search);
const next = p.get('next') || '/';
document.getElementById('f').action = `/login?next=${encodeURIComponent(next)}`;
if (p.has('error')) document.getElementById('err').hidden = false;
