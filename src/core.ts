import { type StandardSchemaV1, standardValidate } from "./standard";
import { decoding, encoding } from "lib0";
import { Decoder, Encoder, type Options } from "cbor-x";

const cborOptions: Options = {
  pack: true,
  // bundleStrings: true, // this option is occasionally causing problems reading the message
  useRecords: true,
};
const cborEnc = new Encoder(cborOptions);
const cborDec = new Decoder(cborOptions);

export class AckIdGenerator {
  #n = 0;

  next(): string {
    this.#n = (this.#n + 1) % Number.MAX_SAFE_INTEGER;
    return this.#n.toString(36);
  }
}

export interface AckListener<O = any> {
  proc: Proc<any, O>;
  resolve(output: O): void;
  reject(error: Error): void;
}

export interface ProcSchema<I, O> {
  /**
   * What the proc function should receive.
   */
  takes?: StandardSchemaV1<I>;

  /**
   * What the proc function should return.
   */
  returns?: StandardSchemaV1<O>;
}

/**
 * Configuration object passed to the Proc constructor.
 */
export interface ProcConfig<I, O> extends ProcSchema<I, O> {
  /**
   * A unique name for this proc.
   */
  name: string;

  /**
   * Time to wait before considering this call a failure.
   * Value in milliseconds. Default 5000 (5 seconds).
   */
  timeout?: number;
}

/**
 * Infers the input value type based on a Proc schema.
 */
export type ProcInput<T extends ProcSchema<any, any>> =
  T["takes"] extends StandardSchemaV1<any, any>
    ? StandardSchemaV1.InferOutput<T["takes"]>
    : null;

/**
 * Infers the handler return value type based on a Proc schema.
 */
export type ProcOutput<T extends ProcSchema<any, any>> =
  T["returns"] extends StandardSchemaV1<any, any>
    ? StandardSchemaV1.InferOutput<T["returns"]>
    : void;

export type MaybePromise<T> = T | Promise<T>;

/**
 * Defines a proc with a name, schema and default options.
 * Can be implemented by the client or server.
 */
export function createProc<Config extends ProcConfig<any, any>>(
  config: Config
): Proc<ProcInput<Config>, ProcOutput<Config>> {
  return new Proc(config) as any;
}

/**
 * An abstract definition of a procedure that can be implemented or called.
 */
export class Proc<I, O> {
  readonly name: string;
  readonly schema: ProcSchema<I, O>;
  readonly timeout: number;

  constructor(config: ProcConfig<I, O>) {
    this.name = config.name;
    this.schema = config as any;
    this.timeout = config.timeout ?? 5000;
  }

  /**
   * Parses potential input for this procedure. Rejects if input doesn't match the schema.
   */
  async parseInput(value: any): Promise<I> {
    if (this.schema.takes == null) {
      return null as I;
    } else {
      return standardValidate(this.schema.takes, value);
    }
  }

  /**
   * Parses potential output from this procedure. Rejects if output doesn't match the schema.
   */
  async parseOutput(value: any): Promise<O> {
    if (this.schema.returns == null) {
      return null as O;
    } else {
      return standardValidate(this.schema.returns, value);
    }
  }
}

export interface Impl<Handler> {
  proc: Proc<any, any>;
  handler: Handler;
}

/**
 * Represents a link from client->server or server->client.
 */
export interface Connection {
  call<I, O>(proc: Proc<I, O>, input: I): Promise<O>;
}

export enum MessageType {
  Ping = 0,
  Pong = 1,
  Proc = 2,
  Ack = 3,
}

export enum MessageDataType {
  Empty = 0,
  JSON = 1,
  Binary = 2,
}

export function getMessageType(message: Uint8Array): MessageType {
  return decoding.peekUint8(decoding.createDecoder(message));
}

function _encodeData(encoder: encoding.Encoder, data: unknown) {
  if (data instanceof ArrayBuffer) {
    data = new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    encoding.writeUint8(encoder, MessageDataType.Binary);
    encoding.writeVarUint8Array(encoder, data);
  } else if (data !== undefined) {
    encoding.writeUint8(encoder, MessageDataType.JSON);
    encoding.writeVarUint8Array(encoder, cborEnc.encode(data));
  } else {
    encoding.writeUint8(encoder, MessageDataType.Empty);
  }
}

export function encodeProc<I>(
  proc: Proc<I, any>,
  ackId: string,
  input: I
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, MessageType.Proc);
  encoding.writeVarString(encoder, ackId);
  encoding.writeVarString(encoder, proc.name);
  _encodeData(encoder, input);
  return encoding.toUint8Array(encoder);
}

export function decodeProc(message: Uint8Array) {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readUint8(decoder);
  if (type !== MessageType.Proc) {
    throw new TypeError(
      `Message cannot be decoded as a procedure call. Expected type ${MessageType.Proc} but got ${type}`
    );
  }
  const ackId = decoding.readVarString(decoder);
  const name = decoding.readVarString(decoder);
  const dataType = decoding.readUint8(decoder);
  switch (dataType) {
    case MessageDataType.Binary:
      return {
        name,
        ackId,
        input: decoding.readVarUint8Array(decoder),
      };
    case MessageDataType.JSON:
      return {
        name,
        ackId,
        input: cborDec.decode(decoding.readVarUint8Array(decoder)),
      };
    case MessageDataType.Empty: {
      return {
        name,
        ackId,
      };
    }
    default:
      throw new TypeError(`Unknown data type ${dataType}`);
  }
}

export function encodeAck(
  ackId: string,
  success: boolean,
  output: any
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, MessageType.Ack);
  encoding.writeVarString(encoder, ackId);
  encoding.writeUint8(encoder, success ? 1 : 0);
  if (success) {
    _encodeData(encoder, output);
  } else {
    if (output instanceof Error) {
      output = output.message;
    }
    if (typeof output !== "string") {
      throw new Error(
        `Output should be an error message if success is false. Got: ${output}`
      );
    }
    encoding.writeVarString(encoder, output);
  }

  return encoding.toUint8Array(encoder);
}

export function decodeAck(message: Uint8Array) {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readUint8(decoder);
  if (type !== MessageType.Ack) {
    throw new TypeError(
      `Message cannot be decoded as an acknowledgement. Expected type ${MessageType.Ack} but got ${type}`
    );
  }
  const ackId = decoding.readVarString(decoder);
  const success = Boolean(decoding.readUint8(decoder));
  if (success) {
    const dataType = decoding.readUint8(decoder);
    switch (dataType) {
      case MessageDataType.Binary:
        return {
          ackId,
          success,
          output: decoding.readVarUint8Array(decoder),
        };
      case MessageDataType.JSON:
        return {
          ackId,
          success,
          output: cborDec.decode(decoding.readVarUint8Array(decoder)),
        };
      case MessageDataType.Empty: {
        return {
          ackId,
          success,
        };
      }
      default:
        throw new TypeError(`Unknown data type ${dataType}`);
    }
  } else {
    return {
      ackId,
      success,
      error: decoding.readVarString(decoder),
    };
  }
}

function _encodePing(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, MessageType.Ping);
  return encoding.toUint8Array(encoder);
}

function _encodePong(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, MessageType.Pong);
  return encoding.toUint8Array(encoder);
}

// No need to encode more than once because these will always be the same.
export const PING_MESSAGE = _encodePing();
export const PONG_MESSAGE = _encodePong();

/**
 * Prints a human readable representation of a message for debug purposes.
 *
 * @param message - The binary message.
 * @param callback - If passed, the decoded object will be passed to this function instead of console.log()
 */
export function printMessage(
  message: Uint8Array,
  callback?: (data: any) => void
) {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readUint8(decoder);

  let data: any;

  switch (type) {
    case MessageType.Ping:
      data = {
        type: "ping",
        payload: {
          ackId: decoding.readVarString(decoder),
        },
      };
      break;
    case MessageType.Proc:
      data = {
        type: "procedure",
        payload: decodeProc(message),
      };
      break;
    case MessageType.Ack:
      data = {
        type: "acknowledgement",
        payload: decodeAck(message),
      };
      break;
  }

  if (callback) {
    callback(data);
  } else {
    console.log(data);
  }
}
