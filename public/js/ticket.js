// "Open a ticket" page. Attachments are validated client-side only (type, size, count); in this
// prototype only their metadata is sent, never the files — and never to OpenAI.
import { $, icons, mountHeader, getConfig, escapeHtml } from './common.js';

mountHeader();
$('#cat-chev').outerHTML = icons.chevronDown.replace('<svg', '<svg class="sel-chev"');
$('#browse').innerHTML = `${icons.upload} Upload file`;
$('#check').innerHTML = icons.check;

const MAX_FILES = 3;
const MAX_BYTES = 10 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
let files = [];

getConfig().then((cfg) => {
  $('#cat').insertAdjacentHTML('beforeend', cfg.ticket_categories.map((c) => `<option>${escapeHtml(c)}</option>`).join(''));
});

const valid = () => $('#cat').value && $('#desc').value.trim().length >= 5;
const refresh = () => {
  $('#submit').disabled = !valid();
  $('#count').textContent = `${$('#desc').value.length.toLocaleString('en-US')} / 2,000`;
};
$('#cat').addEventListener('change', refresh);
$('#desc').addEventListener('input', refresh);

function showError(msg) { $('#err').hidden = !msg; $('#err').textContent = msg || ''; }

function addFiles(list) {
  showError('');
  for (const f of list) {
    if (files.length >= MAX_FILES) { showError(`You can attach up to ${MAX_FILES} files.`); break; }
    const typeOk = OK_TYPES.includes(f.type) || /\.(jpe?g|png|pdf)$/i.test(f.name);
    if (!typeOk) { showError(`${f.name}: only jpg, png or pdf files are allowed.`); continue; }
    if (f.size > MAX_BYTES) { showError(`${f.name} is larger than 10MB.`); continue; }
    files.push(f);
  }
  renderFiles();
}
function renderFiles() {
  $('#files').innerHTML = files.map((f, i) => `<li>${icons.file.replace('<svg', '<svg style="width:16px;height:16px;color:#1F4A44"')}<span class="n">${escapeHtml(f.name)}</span><span class="sz">${(f.size / 1024 / 1024).toFixed(2)} MB</span><button type="button" data-i="${i}" aria-label="Remove ${escapeHtml(f.name)}">${icons.x}</button></li>`).join('');
  $('#files').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { files.splice(+b.dataset.i, 1); renderFiles(); }));
}

$('#browse').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!valid()) return;
  $('#submit').disabled = true;
  try {
    const r = await fetch('/api/tickets', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: $('#cat').value, description: $('#desc').value.trim(), attachments: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || 'Could not submit the ticket.');
    $('#num').textContent = `#${j.ticket_number}`;
    $('#form').hidden = true;
    $('#success').hidden = false;
  } catch (ex) {
    showError(ex.message);
    $('#submit').disabled = false;
  }
});
refresh();
