#!/usr/bin/env bash
python3 -c "
import json, platform

profile = {
    'hostname': platform.node(),
    'os': platform.system() + ' ' + platform.release(),
    'architecture': platform.machine(),
    'processor': platform.processor() or 'Generic x86_64',
    'status': 'ACTIVE'
}

with open('hw-profile.json', 'w') as f:
    json.dump(profile, f, indent=2)

print('Generated hw-profile.json successfully.')
" || python -c "
import json, platform

profile = {
    'hostname': platform.node(),
    'os': platform.system() + ' ' + platform.release(),
    'architecture': platform.machine(),
    'processor': platform.processor() or 'Generic x86_64',
    'status': 'ACTIVE'
}

with open('hw-profile.json', 'w') as f:
    json.dump(profile, f, indent=2)

print('Generated hw-profile.json successfully.')
"
