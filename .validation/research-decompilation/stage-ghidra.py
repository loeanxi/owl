import hashlib
import json
import pathlib
import stat
import zipfile

home = pathlib.Path(r'D:\owl\owl-re-v1\data\owl\tools\research-decompilers').resolve()
archive = home/'downloads/ghidra-verified.zip'
hash = hashlib.sha256()
with archive.open('rb') as source:
    while chunk := source.read(1024*1024):
        hash.update(chunk)
if hash.hexdigest() != 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db':
    raise RuntimeError('Ghidra archive hash mismatch')
output = home/'ghidra'
output.mkdir(exist_ok=True)
total = 0
with zipfile.ZipFile(archive) as source:
    for entry in source.infolist():
        name = pathlib.PurePosixPath(entry.filename)
        if name.is_absolute() or '..' in name.parts or '\\' in entry.filename or ':' in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
            raise RuntimeError('Unsafe official archive entry')
        total += entry.file_size
        if total > 3_000_000_000:
            raise RuntimeError('Extraction size exceeded')
        target = (output/pathlib.Path(*name.parts)).resolve()
        if not target.is_relative_to(output):
            raise RuntimeError('Destination escaped tools directory')
        if entry.is_dir():
            target.mkdir(parents=True,exist_ok=True)
        else:
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(source.read(entry))
installation = output/'ghidra_12.1.4_PUBLIC'
if not (installation/'support/analyzeHeadless.bat').is_file():
    raise RuntimeError('Ghidra launcher missing')
config = {'ghidraHome':str(installation),'javaHome':r'D:\developTool\java21'}
(home/'native-toolchain.json').write_text(json.dumps(config,indent=2),encoding='utf-8')
print(json.dumps({'config':config,'extractedBytes':total,'archiveSha256':hash.hexdigest()},indent=2))
