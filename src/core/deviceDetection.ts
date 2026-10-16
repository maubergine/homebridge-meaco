import type { TuyaCloudDevice } from '../tuya/types.js';

/**
 * Tuya product IDs of confirmed Meaco air conditioners. Product IDs are fixed per
 * product, so this is the most reliable signal. Sources: real captures and the
 * make-all/tuya-local device configs.
 */
export const MEACO_PRODUCT_IDS: ReadonlyMap<string, string> = new Map([
  ['pgdwirmckucamyz7', 'MeacoCool MC Series 10000 PRO (MC10000RPRO)'],
  ['uhczsyv4vdrcscwv', 'MeacoCool MC Series 10000 PRO CH'],
  ['anelna1pjt7avtye', 'MeacoCool MC Series 12000 PRO CH'],
  ['sijcdtk46wa9uews', 'Meaco Cirro+ 14000 (CIRRO14000PRO)'],
  ['smu5pc1ruzadfnuk', 'Meaco Cirro+ 14000 CH (CIRRO14000CHPRO)'],
  ['ppkadch47agj28tc', 'Meaco Cirro+ 16000 (CIRRO16000PRO)'],
  ['hxibo4e0e20uzupv', 'Meaco Cirro+ 16000 CH (CIRRO16000CHPRO)'],
]);

/**
 * Newer Meaco ranges report an internal model code as the Tuya product name rather
 * than a "Meaco…" name: `A-<range>[-]<BTU>K[-<variant>]`, e.g. `A-Cirro-14k-INV`,
 * `A-Cirro-16K-CHINV`, `A-COSTCO12K-PRO-CH`. The `A-` prefix alone is not Meaco-
 * specific, so only known Meaco range names are accepted.
 */
const MEACO_MODEL_CODE = /^A-(?:Cirro|COSTCO)-?\d{1,2}K(?:-|$)/i;

export type MeacoMatch = 'product_id' | 'product_name' | 'model_code' | 'configured';

/**
 * Returns why a Tuya `kt` device is treated as a Meaco air conditioner, or null if
 * it is not. Data-point layouts are deliberately not used: other brands (Suntec,
 * Temprium) ship the same Tuya hardware with identical data points.
 */
export function matchMeacoDevice(
  device: Pick<TuyaCloudDevice, 'id' | 'productId' | 'productName'>,
  configuredDeviceIds: ReadonlySet<string>,
): MeacoMatch | null {
  if (MEACO_PRODUCT_IDS.has(device.productId)) return 'product_id';
  const name = device.productName.trim();
  if (name.toLowerCase().startsWith('meaco')) return 'product_name';
  if (MEACO_MODEL_CODE.test(name)) return 'model_code';
  if (configuredDeviceIds.has(device.id)) return 'configured';
  return null;
}
