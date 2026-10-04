import hashlib
import json
import pathlib
import stat
import zipfile

home = pathlib.Path(r'D:\owl\owl-re-v1\data\owl\tools\research-decompilers').resolve()
record = json.loads((home / 'provision-record.json').read_text(encoding='utf-8'))

def extract_checked(archive, output, max_total):
    total = 0
    output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            path = pathlib.PurePosixPath(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or ':' in entry.filename:
                raise RuntimeError('Unsafe archive name')
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise RuntimeError('Archive links are not allowed')
            total += entry.file_size
            if total > max_total:
                raise RuntimeError('Archive output cap exceeded')
            target = (output / pathlib.Path(*path.parts)).resolve()
            if not target.is_relative_to(output.resolve()):
                raise RuntimeError('Extraction escaped destination')
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source.read(entry))
    return total

d8home = home / 'd8-12.6.228.30-windows'
print('d8 extracted bytes', extract_checked(home / 'downloads/d8-12.6.228.30-windows.zip', d8home, 100_000_000))
with zipfile.ZipFile(home / 'downloads' / record['parse']['wheel']) as wheel:
    (home / 'view8/parse.py').write_bytes(wheel.read('parse.py'))
    for entry in wheel.infolist():
        if entry.filename.endswith(('LICENSE', 'LICENSE.txt')):
            (home / 'view8/parse-LICENSE.txt').write_bytes(wheel.read(entry))

digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
d8 = next(d8home.rglob('d8.exe'), None) or next(d8home.rglob('d8-12.6.228.30-windows.exe'), None)
snapshot = next(d8home.rglob('snapshot_blob.bin'), None)
if not d8 or not snapshot:
    print('archive files:', [str(path.relative_to(home)) for path in d8home.rglob('*') if path.is_file()])
    raise RuntimeError('Matching d8/snapshot missing')
python = pathlib.Path(r'C:\Users\李现\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
manifest = { 'schemaVersion':1, 'engine':'12.6.228.30', 'adapter':'jsc2js-view8',
    'releaseUrl': record['releaseUrl'], 'releaseArchiveSha256': record['releaseArchiveSha256'],
    'sourceCommit':record['sourceCommit'], 'decoderSourceCommit':record['decoderSourceCommit'],
    'd8':{'path':d8.relative_to(home).as_posix(),'sha256':digest(d8)},
    'snapshot':{'path':snapshot.relative_to(home).as_posix(),'sha256':digest(snapshot)},
    'python':{'path':str(python),'sha256':digest(python)},
    'view8':{'path':'view8/view8.py','sha256':digest(home/'view8/view8.py')},
    'files':[{ 'path':path.relative_to(home).as_posix(), 'sha256':digest(path)}
        for folder in (home/'view8', d8home) for path in sorted(folder.rglob('*')) if path.is_file()]
}
(home/'toolchain.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print('manifest files', len(manifest['files']))
