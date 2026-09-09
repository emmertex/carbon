import { landingWorkspaceUrl } from '../lib/landingLinks';

// Progressive enhancement only; the document and all CTAs work without JS.
const base = document.body.dataset.workspaceDomain;
if (base) {
  document.getElementById('workspace-entry')!.hidden = false;
  document.getElementById('workspace-form')!.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('workspace') as HTMLInputElement;
    const url = landingWorkspaceUrl(input.value, base, location.origin);
    if (url) location.assign(url);
    else {
      document.getElementById('workspace-error')!.textContent =
        'Enter a workspace name using letters, numbers and hyphens, or its full hostname.';
      input.focus();
    }
  });
}
