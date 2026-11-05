const mediaExtensions = {
  image: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']),
  video: new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']),
  audio: new Set(['mp3', 'm4a', 'aac', 'wav', 'oga', 'ogg', 'opus', 'flac']),
};
const documentExtensions = new Set(['pdf', 'txt', 'md', 'csv', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']);

export function mediaKind(name) {
  const extension = name.split('.').at(-1)?.toLowerCase() || '';
  return Object.entries(mediaExtensions).find(([, extensions]) => extensions.has(extension))?.[0] || '';
}

function fileCategory(name) {
  const kind = mediaKind(name);
  if (kind) return kind;
  const extension = name.split('.').at(-1)?.toLowerCase() || '';
  return documentExtensions.has(extension) ? 'document' : '';
}

export function filterAndSortFiles(items, { category = 'all', search = '', sort = 'name-asc' } = {}) {
  const query = search.trim().toLocaleLowerCase('zh-TW');
  return items.filter((item) => {
    if (category !== 'all' && (item.isDirectory || fileCategory(item.name) !== category)) return false;
    return !query || item.name.toLocaleLowerCase('zh-TW').includes(query);
  }).sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    if (sort.startsWith('modified')) {
      const difference = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
      return sort.endsWith('asc') ? difference : -difference;
    }
    if (sort.startsWith('size')) {
      const difference = (a.size || 0) - (b.size || 0);
      return sort.endsWith('asc') ? difference : -difference;
    }
    const difference = a.name.localeCompare(b.name, 'zh-TW', { numeric: true, sensitivity: 'base' });
    return sort.endsWith('desc') ? -difference : difference;
  });
}
