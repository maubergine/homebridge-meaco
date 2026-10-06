import { describe, it, expect } from 'vitest';

import { matchMeacoDevice, MEACO_PRODUCT_IDS } from '../../src/core/deviceDetection.js';

const NONE = new Set<string>();
const device = (productName: string, productId = 'unknownpid000000', id = 'dev1') =>
  ({ id, productId, productName });

describe('matchMeacoDevice', () => {
  it.each([...MEACO_PRODUCT_IDS.keys()])('matches known product ID %s regardless of name', (pid) => {
    expect(matchMeacoDevice(device('Air Conditioner', pid), NONE)).toBe('product_id');
  });

  it.each([
    'MeacoCool MC Series 10000 PRO',
    'MeacoCool MC Series 12000 PRO CH',
    'Meaco Cirro+ 14000 BTU Inverter',
  ])('matches Meaco brand name %s', (name) => {
    expect(matchMeacoDevice(device(name), NONE)).toBe('product_name');
  });

  it.each([
    'A-Cirro-14k-INV',
    'A-Cirro-14k-CHINV',
    'A-Cirro-16K-CHINV',
    'A-Cirro-12K',
    'A-COSTCO12K-PRO-CH',
    ' a-costco12k-pro-ch ',
  ])('matches Meaco model code %s', (name) => {
    expect(matchMeacoDevice(device(name), NONE)).toBe('model_code');
  });

  it.each([
    '',
    'Suntec Coolfixx',
    'Temprium PAC011',
    'A-Other-12K-CH',
    'A-COSTCO',
    'A-COSTCO-FAN',
    'A-Cirro12000',
    'Cirro 14k',
    'Costco 12K AC',
  ])('rejects %s', (name) => {
    expect(matchMeacoDevice(device(name), NONE)).toBeNull();
  });

  it('matches an unrecognised device listed in the plugin config', () => {
    expect(matchMeacoDevice(device('Generic AC', 'x', 'dev42'), new Set(['dev42']))).toBe('configured');
  });

  it('prefers intrinsic signals over the config escape hatch', () => {
    expect(matchMeacoDevice(device('A-Cirro-14k-INV', 'x', 'dev42'), new Set(['dev42']))).toBe('model_code');
  });
});
