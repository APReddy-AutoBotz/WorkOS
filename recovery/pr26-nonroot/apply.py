#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('usage: apply.py <controller-root>')
root = Path(sys.argv[1])
workflow_path = root / '.github/workflows/wos01a-clean-runtime-acceptance-v2.yml'
verifier_path = root / '.github/scripts/verify-wos01a-controller-v2.mjs'
workflow = workflow_path.read_text()

replacements = [
(
'''          events {}\n          http {\n            access_log off;\n            server {\n              listen 8080;\n              root /srv/workos;\n              location / { try_files $uri $uri/ /index.html; }\n            }\n          }\n''',
'''          events {}\n          pid /var/run/nginx.pid;\n          error_log /dev/stderr notice;\n          http {\n            access_log off;\n            client_body_temp_path /var/cache/nginx/client_temp;\n            proxy_temp_path /var/cache/nginx/proxy_temp;\n            fastcgi_temp_path /var/cache/nginx/fastcgi_temp;\n            uwsgi_temp_path /var/cache/nginx/uwsgi_temp;\n            scgi_temp_path /var/cache/nginx/scgi_temp;\n            server {\n              listen 8080;\n              root /srv/workos;\n              location / { try_files $uri $uri/ /index.html; }\n            }\n          }\n''',
'nginx config'),
(
'''          docker run --detach --name wos01a-static-target \\\n            --read-only --cap-drop ALL --security-opt no-new-privileges \\\n            --pids-limit 64 --memory 128m --network bridge \\\n            --tmpfs /var/cache/nginx:rw,noexec,nosuid,size=16m \\\n            --tmpfs /var/run:rw,noexec,nosuid,size=1m \\\n            --tmpfs /tmp:rw,noexec,nosuid,size=1m \\\n            --publish 127.0.0.1:4173:8080 \\\n            --mount "type=bind,src=$PWD/browser-bundle/dist,dst=/srv/workos,readonly" \\\n            --mount "type=bind,src=$config,dst=/etc/nginx/nginx.conf,readonly" \\\n            nginx:1.27-alpine > "$evidence/container-id.txt"\n''',
'''          docker run --detach --name wos01a-static-target \\\n            --user 101:101 \\\n            --read-only --cap-drop ALL --security-opt no-new-privileges \\\n            --pids-limit 64 --memory 128m --network bridge \\\n            --tmpfs /var/cache/nginx:rw,noexec,nosuid,size=16m,uid=101,gid=101,mode=700 \\\n            --tmpfs /var/run:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=700 \\\n            --tmpfs /tmp:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=700 \\\n            --publish 127.0.0.1:4173:8080 \\\n            --mount "type=bind,src=$PWD/browser-bundle/dist,dst=/srv/workos,readonly" \\\n            --mount "type=bind,src=$config,dst=/etc/nginx/nginx.conf,readonly" \\\n            nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 \\\n            > "$evidence/container-id.txt"\n''',
'docker invocation'),
(
'''          inspect="$(docker inspect wos01a-static-target)"\n          jq -e '.[0].HostConfig.Privileged == false\n            and .[0].HostConfig.PidMode == ""\n            and .[0].HostConfig.ReadonlyRootfs == true\n            and .[0].HostConfig.Binds == null\n            and .[0].HostConfig.SecurityOpt == ["no-new-privileges"]' <<<"$inspect" >/dev/null\n''',
'''          docker inspect wos01a-static-target > "$evidence/container-inspect.json"\n          docker logs wos01a-static-target > "$evidence/container-startup.log" 2>&1 || true\n          inspect="$(cat "$evidence/container-inspect.json")"\n          jq -e '.[0].State.Running == true\n            and .[0].Config.User == "101:101"\n            and .[0].HostConfig.Privileged == false\n            and .[0].HostConfig.PidMode == ""\n            and .[0].HostConfig.ReadonlyRootfs == true\n            and .[0].HostConfig.Binds == null\n            and .[0].HostConfig.SecurityOpt == ["no-new-privileges"]\n            and .[0].HostConfig.CapDrop == ["ALL"]\n            and .[0].HostConfig.Memory == 134217728\n            and .[0].HostConfig.PidsLimit == 64\n            and .[0].HostConfig.NetworkMode == "bridge"\n            and ([.[0].Mounts[] | select(.Type == "bind")] | length == 2)\n            and ([.[0].Mounts[] | select(.Type == "bind") | .RW] | all(. == false))' <<<"$inspect" >/dev/null\n''',
'runtime inspection'),
]
for old, new, label in replacements:
    count = workflow.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one old block, found {count}')
    workflow = workflow.replace(old, new)
workflow_path.write_text(workflow)

verifier = verifier_path.read_text()
anchor = 'assert.match(browserJob, /sha256sum -c \\.\\.\\/files\\.sha256/);\n'
additions = '''assert.match(browserJob, /--user 101:101/);\nassert.match(browserJob, /--read-only --cap-drop ALL --security-opt no-new-privileges/);\nassert.match(browserJob, /--pids-limit 64 --memory 128m --network bridge/);\nassert.match(browserJob, /--tmpfs \\/var\\/cache\\/nginx:rw,noexec,nosuid,size=16m,uid=101,gid=101,mode=700/);\nassert.match(browserJob, /--tmpfs \\/var\\/run:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=700/);\nassert.match(browserJob, /--tmpfs \\/tmp:rw,noexec,nosuid,size=1m,uid=101,gid=101,mode=700/);\nassert.match(browserJob, /nginx:1\\.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10/);\nassert.match(browserJob, /pid \\/var\\/run\\/nginx\\.pid;/);\nassert.match(browserJob, /client_body_temp_path \\/var\\/cache\\/nginx\\/client_temp;/);\nassert.match(browserJob, /\\.State\\.Running == true/);\nassert.match(browserJob, /\\.Config\\.User == "101:101"/);\nassert.match(browserJob, /\\.HostConfig\\.CapDrop == \\["ALL"\\]/);\nassert.match(browserJob, /\\.HostConfig\\.Memory == 134217728/);\nassert.match(browserJob, /\\.HostConfig\\.PidsLimit == 64/);\nassert.match(browserJob, /\\.HostConfig\\.NetworkMode == "bridge"/);\nassert.match(browserJob, /select\\(\\.Type == "bind"\\)[\\s\\S]*length == 2/);\nassert.match(browserJob, /select\\(\\.Type == "bind"\\) \\| \\.RW\\][\\s\\S]*all\\(\\. == false\\)/);\nassert.match(browserJob, /container-startup\\.log/);\n'''
if verifier.count(anchor) != 1:
    raise SystemExit(f'verifier anchor count={verifier.count(anchor)}')
if '--user 101:101' in verifier:
    raise SystemExit('non-root verifier assertions already exist')
verifier_path.write_text(verifier.replace(anchor, anchor + additions))
