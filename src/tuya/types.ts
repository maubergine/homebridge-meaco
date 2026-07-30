export type TuyaValue = boolean | number | string;

export interface TuyaFunctionSpec {
  code: string;
  desc: string;
  name: string;
  type: 'Boolean' | 'Enum' | 'Integer' | 'String';
  values: string;
}

export interface TuyaSpecResponse {
  result: {
    category: string;
    functions: TuyaFunctionSpec[];
    status: TuyaFunctionSpec[];
  };
  success: boolean;
  t: number;
}

export interface TuyaStatusItem {
  code: string;
  value: TuyaValue;
}

export interface TuyaDeviceStatusResponse {
  result: TuyaStatusItem[];
  success: boolean;
  t: number;
}

export interface TuyaDeviceInfo {
  id: string;
  name: string;
  category: string;
  product_id: string;
  product_name: string;
  online: boolean;
  status: TuyaStatusItem[];
  sub: boolean;
  time_zone: string;
  uid: string;
  uuid: string;
  owner_id: string;
  ip: string;
  local_key: string;
  model: string;
  mac: string;
  sn: string;
  create_time: number;
  update_time: number;
  active_time: number;
}

export interface TuyaDeviceInfoResponse {
  result: TuyaDeviceInfo;
  success: boolean;
  t: number;
}

export interface TuyaProductFunctionsResponse {
  result: {
    category: string;
    functions: TuyaFunctionSpec[];
  };
  success: boolean;
  t: number;
}

export interface TuyaCloudDevice {
  id: string;
  name: string;
  customName: string;
  model: string;
  category: string;
  productId: string;
  productName: string;
  isOnline: boolean;
  uuid: string;
  icon: string;
  ip: string;
  lat: string;
  lon: string;
  localKey: string;
  sub: boolean;
  timeZone: string;
  bindSpaceId: string;
  activeTime: number;
  createTime: number;
  updateTime: number;
}

export interface TuyaDeviceListResponse {
  result: TuyaCloudDevice[];
  success: boolean;
  t: number;
}

export interface TuyaDeviceModelResponse {
  result: { model: string };
  success: boolean;
  t: number;
  tid?: string;
}

// ── Message Service (Pulsar) ──────────────────────────────────────────────────

/** The `code`/`value` pair both report shapes have in common. */
export interface TuyaPulsarDatapoint {
  code: string;
  value: TuyaValue;
}

/**
 * One changed datapoint in a protocol 4 status report. Alongside `code`/`value`
 * Tuya also includes the numeric DP id as a stringified key (e.g. `"1": "true"`),
 * which we ignore in favour of the code.
 */
export interface TuyaPulsarStatusItem extends TuyaPulsarDatapoint {
  /** Device-side timestamp of the change, in epoch milliseconds. */
  t?: number;
}

/** The decrypted `data` object of a device status report (protocol 4). */
export interface TuyaPulsarStatusData {
  dataId: string;
  devId: string;
  productKey: string;
  status: TuyaPulsarStatusItem[];
}

/** One changed datapoint in a protocol 1000 property report. */
export interface TuyaPulsarPropertyItem extends TuyaPulsarDatapoint {
  dpId?: number;
  /** Device-side timestamp of the change, in epoch milliseconds. */
  time?: number;
}

/**
 * The decrypted `data` object of a protocol 1000 property report. Note the
 * datapoints sit under `bizData`, not at the top level as Tuya's message-type
 * documentation shows.
 */
export interface TuyaPulsarPropertyData {
  bizCode: string;
  bizData: {
    devId: string;
    dataId: string;
    productId: string;
    properties: TuyaPulsarPropertyItem[];
  };
  ts: number;
}

/**
 * The envelope Tuya sends over the WebSocket. `payload` is base64-encoded JSON whose
 * `data` field is itself AES-encrypted; `properties.em` names the cipher when it is
 * anything other than the default ECB mode.
 */
export interface TuyaPulsarEnvelope {
  messageId: string;
  payload: string;
  properties?: { em?: string };
  publishTime?: string;
  redeliveryCount?: number;
  key?: string;
}

/** The base64-decoded `payload`, before `data` is decrypted. */
export interface TuyaPulsarPayload {
  data: string;
  protocol: number;
  pv: string;
  sign: string;
  t: number;
}
