// "Open a ticket" page. Attachments (3 files, jpg/png/pdf, 10MB each) are checked here for a quick answer
// and again by the server, which forwards them with the ticket to the main app — never to the model provider.
import { $, icons, mountHeader, getConfig, escapeHtml, looksLikeEmail, addAttachments, attachmentItems, postTicket } from './common.js';

mountHeader();
$('#cat-chev').outerHTML = icons.chevronDown.replace('<svg', '<svg class="sel-chev"');
$('#browse').innerHTML = `${icons.upload} Upload file`;
$('#check').innerHTML = icons.check;

let files = [];

getConfig().then((cfg) => {
  $('#cat').insertAdjacentHTML('beforeend', cfg.ticket_categories.map((c) => `<option>${escapeHtml(c)}</option>`).join(''));
  if (cfg.ticket_attachments === false) { $('#att-block').hidden = true; files = []; }
});

const valid = () => $('#cat').value && $('#desc').value.trim().length >= 10 && looksLikeEmail($('#email').value.trim());
const refresh = () => {
  $('#submit').disabled = !valid();
  $('#count').textContent = `${$('#desc').value.length.toLocaleString('en-US')} / 2,000`;
};
$('#cat').addEventListener('change', refresh);
$('#desc').addEventListener('input', refresh);
$('#email').addEventListener('input', refresh);

function showError(msg) { $('#err').hidden = !msg; $('#err').textContent = msg || ''; }

function addFiles(list) {
  showError(addAttachments(files, list));
  renderFiles();
}
function renderFiles() {
  $('#files').innerHTML = attachmentItems(files);
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
    const r = await postTicket({ category: $('#cat').value, description: $('#desc').value.trim(), email: $('#email').value.trim() }, files);
    const j = await r.json().catch(() => ({}));
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
