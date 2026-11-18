"""Copy reviewed AIGC objects with separate boto3 profiles; Version mappings are emitted as JSONL."""
import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

def digest(body, output=None):
    h = hashlib.sha256()
    size = 0
    try:
        while chunk := body.read(1024 * 1024):
            size += len(chunk)
            h.update(chunk)
            if output is not None:
                output.write(chunk)
    finally:
        body.close()
    return size, h.hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.manifest.read_text().splitlines() if line.strip()]
    destinations = set()
    for r in rows:
        if type(r['size']) is not int or not 0 <= r['size'] <= 5 * 1024**3:
            raise ValueError('Unsupported object size')
        for key, prefix in [('source','lifewood-test/app/'),('target','lifewood-local/')]:
            if not r[key].startswith(prefix) or r[key] == prefix or '..' in r[key].split('/'):
                raise ValueError('Unexpected object prefix')
        if not r.get('etag') or r['target'] in destinations:
            raise ValueError('A pinned source ETag and unique destination are required')
        destinations.add(r['target'])
    if not args.apply:
        print(json.dumps({'planned':len(rows),'bytes':sum(r['size'] for r in rows)}))
        return
    import boto3
    from botocore.exceptions import ClientError
    def client(profile):
        session = boto3.Session(profile_name=profile, region_name='ap-southeast-1')
        return session.client('s3',endpoint_url='https://s3.ap-southeast-1.wasabisys.com')
    source, target = client('aigc-test-read'), client('aigc-prod-copy')
    for r in rows:
        pin = {'VersionId':r['sourceVersion']} if r.get('sourceVersion') else {}
        src = source.get_object(Bucket='aigc-dev', Key=r['source'], IfMatch=r['etag'], **pin)
        with tempfile.TemporaryFile() as tmp:
            size, sha = digest(src['Body'], tmp)
            if size != r['size'] or (r.get('sha256') and sha != r['sha256']):
                raise ValueError('Source integrity mismatch')
            tmp.seek(0)
            headers = {k:src[k] for k in ('ContentType','Metadata','ContentEncoding','ContentDisposition','CacheControl','ContentLanguage') if k in src}
            dest = dict(Bucket='aigc',Key=r['target'])
            try:
                copied=target.put_object(**dest,Body=tmp,ContentLength=size,IfNoneMatch='*',**headers)
            except ClientError as err:
                if err.response['ResponseMetadata']['HTTPStatusCode'] != 412:
                    raise
                copied=target.head_object(**dest)
            version = copied.get('VersionId')
            obj=target.get_object(**dest,**({'VersionId':version} if version else {}))
            if any(obj.get(k) != v for k,v in headers.items()) or digest(obj['Body']) != (size,sha):
                raise ValueError('Destination conflict or integrity mismatch')
            print(json.dumps(dict(source=r['source'],sourceVersion=src.get('VersionId'),target=r['target'],targetVersion=version,targetETag=obj['ETag'],sha256=sha,size=size)),flush=True)

if __name__ == '__main__':
    main()

