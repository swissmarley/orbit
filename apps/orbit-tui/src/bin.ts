#!/usr/bin/env node
import { main } from './cli';
import { processIo } from './io';

process.exitCode = await main(process.argv.slice(2), processIo());
