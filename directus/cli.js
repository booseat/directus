#!/usr/bin/env node
import { updateCheck } from '@directus/update-check';
import { version } from './version.js';

if (version) {
	await updateCheck(version);
}

import('booseat-directus-api/cli/run.js');
