// TEMPORARY diagnostic reporter: surfaces failing tests as annotations.
let n = 0;
export default async function* (source) {
  for await (const e of source) {
    if (e.type === 'test:fail' && n < 15 && e.data.details?.type !== 'suite') {
      n++;
      const err = e.data.details?.error;
      const msg = String(err?.cause?.message ?? err?.message ?? err ?? '').slice(0, 700).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
      yield `::error title=FAILED ${String(e.data.name).slice(0, 80).replace(/[:,\n]/g, ' ')}::${String(e.data.file).split(/[\\/]/).pop()} :: ${msg}\n`;
    }
  }
}
