// Matterport 3D tour beside the plan: opens at the scan point nearest to what was clicked.
// Uses the Embed SDK (v3.1.0) when an SDK key is configured in data/config.json (gitignored, written by
// scripts/extract_building.js). The SDK key is public and locked to its registered domain (PROTOTYPE §9b).
// Without a key, or if the SDK can't connect, it falls back to the plain tour with no fly-to.

const SDK_URL = 'https://api.matterport.com/sdk/bootstrap/3.1.0-0-g1cd7e0997a/sdk.es6.js';

export function createTour({ root, body, title, closeBtn, onClose }) {
  const T = { modelId: null, key: null, sdk: null, iframe: null, connecting: null, sweeps: null };

  closeBtn.addEventListener('click', () => { T.hide(); onClose?.(); });

  T.configure = ({ modelId, key }) => {
    if (T.modelId !== modelId) { T.sdk = null; T.iframe = null; T.connecting = null; T.sweeps = null; body.replaceChildren(); }
    T.modelId = modelId;
    T.key = key || null;
  };
  T.available = () => !!T.modelId;

  T.hide = () => { root.hidden = true; };

  // geometry: the building geometry (for sweeps and the metre transform); target: { x, y, floor, label }
  T.open = async (geometry, target) => {
    if (!T.modelId) return;
    root.hidden = false;
    title.textContent = target.label ? `3D tour: ${target.label}` : '3D tour';
    if (!T.iframe) {
      const src = new URL('https://my.matterport.com/show');
      src.searchParams.set('m', T.modelId);
      src.searchParams.set('play', '1');
      src.searchParams.set('qs', '1');
      src.searchParams.set('help', '0');
      src.searchParams.set('brand', '0');
      if (T.key) src.searchParams.set('applicationKey', T.key);
      const f = document.createElement('iframe');
      f.src = src.toString();
      f.allow = 'fullscreen; xr-spatial-tracking';
      f.title = 'Matterport 3D tour';
      body.replaceChildren(f);
      T.iframe = f;
      if (T.key) T.connecting = connect(f).catch(err => { console.warn('[tour] SDK did not connect:', err); return null; });
    }
    const sdk = T.connecting ? await T.connecting : null;
    if (!sdk) return;
    const sweep = nearestSweep(geometry, target);
    if (!sweep) return;
    try {
      await sdk.Sweep.moveTo(sweep.id, { transition: sdk.Sweep.Transition?.FLY ?? sdk.Sweep.TransitionType?.FLY, transitionTime: 1200 });
    } catch (err) {
      // Scan-point ids from the Model API didn't match the SDK's sweep ids; match by position instead.
      const id = await nearestSdkSweep(sdk, geometry, target).catch(() => null);
      if (id) sdk.Sweep.moveTo(id, { transition: sdk.Sweep.Transition?.FLY ?? sdk.Sweep.TransitionType?.FLY, transitionTime: 1200 }).catch(() => {});
    }
  };

  async function connect(iframe) {
    const mod = await import(`${SDK_URL}?applicationKey=${encodeURIComponent(T.key)}`);
    const sdk = await mod.connect(iframe);
    T.sdk = sdk;
    return sdk;
  }

  async function nearestSdkSweep(sdk, geometry, target) {
    if (!T.sweeps) {
      T.sweeps = await new Promise(resolve => {
        const all = {};
        let timer;
        sdk.Sweep.data.subscribe({
          onAdded(id, item) { all[id] = item; clearTimeout(timer); timer = setTimeout(() => resolve(Object.values(all)), 300); },
          onCollectionUpdated(c) { resolve(Object.values(c)); }
        });
      });
    }
    const floor = geometry.floors[target.floor || 0];
    const { scale, x0, y1 } = floor.transform;
    const mx = target.x / scale + x0, my = y1 - target.y / scale;
    let best = null, bd = Infinity;
    for (const s of T.sweeps) {
      if (!s.position) continue;
      // Showcase is Y-up; the plan's y maps to -z.
      const d = Math.hypot(s.position.x - mx, -s.position.z - my);
      if (d < bd) { bd = d; best = s.sid || s.id; }
    }
    return best;
  }

  return T;
}

export function nearestSweep(geometry, target) {
  const sweeps = (geometry.sweeps || []).filter(s => s.floor === (target.floor || 0));
  let best = null, bd = Infinity;
  for (const s of sweeps) {
    const d = Math.hypot(s.x - target.x, s.y - target.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
