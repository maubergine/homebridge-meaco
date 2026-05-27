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
  value: boolean | number | string;
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

export type TuyaValue = boolean | number | string;
