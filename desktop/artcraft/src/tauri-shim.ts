// Unified Studio local host: no native provider invocation or remote requests.
export const listen = async () => () => {};
export const emit = async () => {};
export const invoke = async (command: string, args?: unknown) => {
  if (command === 'get_app_preferences_command') return {preferences:{play_sounds:false,auto_download:false,preferred_download_directory:{system:'downloads'},preferred_download_filename:'artcraft_convention'}};
  if (command === 'get_provider_order_command') return {status:'success',payload:{providers:[]}};
  if (command === 'get_app_info_command') return {version:'0.41.0-local',platform:'windows'};
  if (command === 'update_app_preference_command') return {status:'success'};
  throw new Error('This cloud operation is unavailable in the local ArtCraft workspace. Use AI Studio for generation with cost confirmation.');
};
export const fetch = async (url: string | URL | Request, options?: RequestInit) => {
  const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, location.href);
  if (!['blob:','data:'].includes(target.protocol) && target.origin !== location.origin) throw new Error('Cloud requests are disabled in the local workspace.');
  return globalThis.fetch(url, options);
};
export const open = async () => { throw new Error('Use Import in the local workspace toolbar.'); };
export const save = open;
export const download = open;
export const downloadDir = async () => '';
