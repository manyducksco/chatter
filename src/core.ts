import { decoding, encoding } from "lib0";
import { input, type ZodType } from "zod";
import { Decoder, Encoder, type Options } from "cbor-x";

const cborOptions: Options = {
  pack: true,
  // bundleStrings: true, // this option is occasionally causing problems reading the message
  useRecords: true,
};
const cborEnc = new Encoder(cborOptions);
const cborDec = new Decoder(cborOptions);

export function createIdGenerator() {
  let n = 0;
  return () => {
    n = (n + 1) % Number.MAX_SAFE_INTEGER;
    return n.toString(36);
  };
}

export type ProcDefinition = { input?: ZodType; output?: ZodType };
export type ProcMap = Record<string, ProcDefinition>;

export interface SocketSchema {
  client: ProcMap;
  server: ProcMap;
}

export function createSchema<S extends SocketSchema>(schema: S) {
  return schema;
}

export interface SocketConfig<S extends SocketSchema> {
  schema: S;

  /**
   * Default time to wait for an acknowledgement before rejecting the promise as a timeout.
   * Defaults to 5 seconds (5,000ms).
   */
  defaultTimeout?: number;

  /**
   * Logs incoming and outgoing messages and timings when true. Defaults to `false`.
   */
  verbose?: boolean;
}

export interface ProcedureOptions {
  /**
   * Amount of milliseconds to wait for acknowledgement before rejecting the promise.
   * Uses the client/server's defaultTimeout value if not specified.
   */
  timeout?: number;
}

export type ProcedureMethod<O extends ProcDefinition> = (
  input: O["input"] extends undefined ? void : input<Exclude<O["input"], undefined>>,
  options?: ProcedureOptions,
) => Promise<O["output"] extends undefined ? void : input<Exclude<O["output"], undefined>>>;

export enum MessageType {
  Ping = 0,
  Procedure = 1,
  Ack = 2,
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

export function encodeProcedure<M extends ProcMap, K extends keyof M>(
  ackId: string,
  name: K,
  input: M[K]["input"],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, MessageType.Procedure);
  encoding.writeVarString(encoder, ackId);
  encoding.writeVarString(encoder, name as string);
  _encodeData(encoder, input);
  return encoding.toUint8Array(encoder);
}

export function decodeProcedure(message: Uint8Array) {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readUint8(decoder);
  if (type !== MessageType.Procedure) {
    throw new TypeError(
      `Message cannot be decoded as a procedure call. Expected type ${MessageType.Procedure} but got ${type}`,
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

export function encodeAck(ackId: string, success: boolean, output: any): Uint8Array {
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
      throw new Error(`Output should be an error message if success is false. Got: ${output}`);
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
      `Message cannot be decoded as an acknowledgement. Expected type ${MessageType.Ack} but got ${type}`,
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

export function encodePing(ackId: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8(encoder, MessageType.Ping);
  encoding.writeVarString(encoder, ackId);
  return encoding.toUint8Array(encoder);
}

/**
 * Decodes a ping message, returning the ackId.
 */
export function decodePing(message: Uint8Array): string {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readUint8(decoder);
  if (type !== MessageType.Ping) {
    throw new TypeError(`Message is not a ping. Expected type ${MessageType.Ping}, but got ${type}`);
  }
  return decoding.readVarString(decoder);
}

/**
 * Prints a human readable representation of a message for debug purposes.
 *
 * @param message - The binary message.
 * @param callback - If passed, the decoded object will be passed to this function instead of console.log()
 */
export function printMessage(message: Uint8Array, callback?: (data: any) => void) {
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
    case MessageType.Procedure:
      data = {
        type: "procedure",
        payload: decodeProcedure(message),
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
