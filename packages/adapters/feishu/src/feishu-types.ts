export type FeishuMessageEvent = {
  event_id?: string;
  sender: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    create_time: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
  };
};

export type FeishuMessageClient = {
  im: {
    message: {
      create(input: {
        params: { receive_id_type: "chat_id" };
        data: { receive_id: string; msg_type: string; content: string; uuid?: string };
      }): Promise<{
        code?: number;
        msg?: string;
        data?: { message_id?: string };
      }>;
    };
    image: {
      create(input: {
        data: { image_type: "message"; image: Buffer | import("node:fs").ReadStream };
      }): Promise<{ image_key?: string } | null>;
    };
    file: {
      create(input: {
        data: {
          file_type: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
          file_name: string;
          file: Buffer | import("node:fs").ReadStream;
        };
      }): Promise<{ file_key?: string } | null>;
    };
  };
};
