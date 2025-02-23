/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Messenger For Original Coast Clothing
 * https://developers.facebook.com/docs/messenger-platform/getting-started/sample-apps/original-coast-clothing
 */

"use strict";
const axios = require("axios");
const FormData = require("form-data");
const Lead = require("./lead"),
  Response = require("./response"),
  GraphApi = require("./graph-api"),
  i18n = require("../i18n.config"),
  config = require("./config");

module.exports = class Receive {
  constructor(user, webhookEvent, isUserRef) {
    this.user = user;
    this.webhookEvent = webhookEvent;
    this.isUserRef = isUserRef;
  }

  // Check if the event is a message or postback and
  // call the appropriate handler function
  async handleMessage() {
    let event = this.webhookEvent;

    let responses;

    try {
      if (event.message) {
        let message = event.message;
        this.sendMessage("typing_on", 0, this.isUserRef, true);
        if (message.attachments) {
          const userInput = await this.speechToText(
            message.attachments[0].payload.url
          );
          responses = await this.handleSpeechToTextMessage(userInput);
        }

        if (message.text) {
          responses = await this.handleTextMessage();
        }
      } else if (event.postback) {
        responses = this.handlePostback();
      } else if (event.referral) {
        responses = this.handleReferral();
      } else if (event.optin) {
        responses = this.handleOptIn();
      } else if (event.pass_thread_control) {
        responses = this.handlePassThreadControlHandover();
      }
    } catch (error) {
      console.error(error);
      responses = {
        text: `An error has occured: '${error}'. We have been notified and \
        will fix the issue shortly!`
      };
    }

    if (Array.isArray(responses)) {
      let delay = 0;
      for (let response of responses) {
        this.sendMessage(response, delay * 2000, this.isUserRef);
        delay++;
      }
    } else {
      this.sendMessage(responses, this.isUserRef);
    }
  }

  async speechToText(fileUrl) {
    try {
      // Download the file using Axios
      const fileResponse = await axios.get(fileUrl, {
        responseType: "arraybuffer"
      });
      const fileBuffer = fileResponse.data;

      // Create a new FormData object
      const formData = new FormData();

      // Append the file buffer to the FormData object
      formData.append("file", fileBuffer, { filename: "file" });

      // Set the appropriate Content-Type header
      const headers = formData.getHeaders();

      // Send the FormData as multipart/form-data
      const response = await axios.post(
        `${process.env.SPEECH_TO_TEXT_API}`,
        formData,
        {
          headers
        }
      );

      // Handle the response as needed
      const result = response.data;
      console.log("speechToText", result.generated);
      return result.generated;
    } catch (error) {
      // Handle any errors
      console.error(error);
    }
  }

  // Handles messages events with text
  async handleTextMessage() {
    console.log(
      "Received text:",
      `${this.webhookEvent.message.text} for ${this.user.psid}`
    );

    let event = this.webhookEvent;

    // check greeting is here and is confident
    let greeting = this.firstEntity(event.message.nlp, "greetings");
    let message = event.message.text.trim().toLowerCase();

    let response;

    if (
      (greeting && greeting.confidence > 0.8) ||
      message.includes("start over")
    ) {
      response = Response.genNuxMessage(this.user);
    } else {
      try {
        const session = await axios.get(
          `${process.env.CHAT_BOT_API}/create_session?session_id=${this.user.psid}`
        );

        const neuraRes = await axios.post(
          `${process.env.CHAT_BOT_API}/generate?session_id=${session.data}`,
          {
            user_input: event.message.text
          }
        );

        if (process.env.DEBUG_MODE === "true") {
          response = [
            Response.genText(neuraRes.data.generated),
            Response.genText("session id: " + session.data)
          ];
        } else {
          response = [Response.genText(neuraRes.data.generated)];
        }
      } catch (error) {
        console.log("API error", error.message);
      }
    }
    return await response;
  }

  async handleSpeechToTextMessage(userInput) {
    let response;
    try {
      const session = await axios.get(
        `${process.env.CHAT_BOT_API}/create_session?session_id=${this.user.psid}`
      );
      const neuraRes = await axios.post(
        `${process.env.CHAT_BOT_API}/generate?session_id=${session.data}`,
        {
          user_input: userInput
        }
      );

      if (process.env.DEBUG_MODE === "true") {
        response = [
          Response.genText(neuraRes.data.generated),
          Response.genText("session id: " + session.data),
          Response.genText("transcribe: " + userInput)
        ];
      } else {
        response = [Response.genText(neuraRes.data.generated)];
      }
    } catch (error) {
      console.log("API error", error.message);
    }
    return response;
  }

  // Handles mesage events with attachments
  handleAttachmentMessage() {
    let response;

    // Get the attachment
    let attachment = this.webhookEvent.message.attachments[0];
    console.log("Received attachment:", `${attachment} for ${this.user.psid}`);

    response = Response.genQuickReply(i18n.__("fallback.attachment"), [
      {
        title: i18n.__("menu.help"),
        payload: "CARE_HELP"
      },
      {
        title: i18n.__("menu.start_over"),
        payload: "GET_STARTED"
      }
    ]);

    return response;
  }

  // Handles mesage events with quick replies
  handleQuickReply() {
    // Get the payload of the quick reply
    let payload = this.webhookEvent.message.quick_reply.payload;

    return this.handlePayload(payload);
  }

  // Handles postbacks events
  handlePostback() {
    let postback = this.webhookEvent.postback;
    // Check for the special Get Starded with referral
    let payload;
    if (postback.referral && postback.referral.type == "OPEN_THREAD") {
      payload = postback.referral.ref;
    } else if (postback.payload) {
      // Get the payload of the postback
      payload = postback.payload;
    }
    if (payload.trim().length === 0) {
      console.log("Ignore postback with empty payload");
      return null;
    }

    return this.handlePayload(payload.toUpperCase());
  }

  // Handles referral events
  handleReferral() {
    // Get the payload of the postback
    let type = this.webhookEvent.referral.type;
    if (type === "LEAD_COMPLETE" || type === "LEAD_INCOMPLETE") {
      let lead = new Lead(this.user, this.webhookEvent);
      return lead.handleReferral(type);
    }
    if (type === "OPEN_THREAD") {
      let payload = this.webhookEvent.referral.ref.toUpperCase();
      if (payload.trim().length === 0) {
        console.log("Ignore referral with empty payload");
        return null;
      }
      return this.handlePayload(payload);
    }
    console.log("Ignore referral of invalid type");
  }

  // Handles optins events
  handleOptIn() {
    let optin = this.webhookEvent.optin;
    // Check for the special Get Starded with referral
    let payload;
    if (optin.type === "notification_messages") {
      payload = "RN_" + optin.notification_messages_frequency.toUpperCase();
      this.sendRecurringMessage(optin.notification_messages_token, 5000);
      return this.handlePayload(payload);
    }
    return null;
  }

  handlePassThreadControlHandover() {
    let new_owner_app_id =
      this.webhookEvent.pass_thread_control.new_owner_app_id;
    let previous_owner_app_id =
      this.webhookEvent.pass_thread_control.previous_owner_app_id;
    let metadata = this.webhookEvent.pass_thread_control.metadata;
    if (config.appId === new_owner_app_id) {
      console.log("Received a handover event, but is not for this app");
      return;
    }
    const lead_gen_app_id = 413038776280800; // App id for Messenger Lead Ads
    if (previous_owner_app_id === lead_gen_app_id) {
      console.log(
        "Received a handover event from Lead Generation Ad will handle Referral Webhook Instead"
      );
      return;
    }
    // We have thread control but no context on what to do, default to New User Experience
    return Response.genNuxMessage(this.user);
  }

  handlePayload(payload) {
    let response;

    // Set the response based on the payload
    if (
      payload === "GET_STARTED" ||
      payload === "DEVDOCS" ||
      payload === "GITHUB"
    ) {
      response = Response.genNuxMessage(this.user);
    } else if (payload.includes("CHAT-PLUGIN")) {
      response = [
        Response.genText(i18n.__("chat_plugin.prompt")),
        Response.genText(i18n.__("get_started.guidance"))
      ];
    } else if (payload.includes("BOOK_APPOINTMENT")) {
      response = [
        Response.genText(i18n.__("care.appointment")),
        Response.genText(i18n.__("care.end"))
      ];
    } else if (payload === "RN_WEEKLY") {
      response = {
        text: `[INFO]The following message is a sample Recurring Notification for a weekly frequency. This is usually sent outside the 24 hour window to notify users on topics that they have opted in.`
      };
    } else if (payload.includes("WHOLESALE_LEAD")) {
      let lead = new Lead(this.user, this.webhookEvent);
      response = lead.handlePayload(payload);
    } else {
      response = {
        text: `This is a default postback message for payload: ${payload}!`
      };
    }

    return response;
  }

  handlePrivateReply(type, object_id) {
    let welcomeMessage =
      i18n.__("get_started.welcome") +
      " " +
      i18n.__("get_started.guidance") +
      ". " +
      i18n.__("get_started.help");

    let response = Response.genQuickReply(welcomeMessage, [
      {
        title: i18n.__("menu.suggestion"),
        payload: "CURATION"
      },
      {
        title: i18n.__("menu.help"),
        payload: "CARE_HELP"
      },
      {
        title: i18n.__("menu.product_launch"),
        payload: "PRODUCT_LAUNCH"
      }
    ]);

    let requestBody = {
      recipient: {
        [type]: object_id
      },
      message: response
    };
    GraphApi.callSendApi(requestBody);
  }

  sendMessage(response, delay = 0, isUserRef, isTyping = false) {
    // Check if there is delay in the response
    if (response === undefined || response === null) {
      return;
    }

    // Construct the message body
    let requestBody = {};
    if (isUserRef) {
      // For chat plugin
      requestBody = {
        recipient: {
          user_ref: this.user.psid
        },
        message: response
      };
    } else if (isTyping) {
      requestBody = {
        recipient: {
          id: this.user.psid
        },
        sender_action: response
      };
    } else {
      requestBody = {
        recipient: {
          id: this.user.psid
        },
        message: response
      };
    }

    // Mitigate restriction on Persona API
    // Persona API does not work for people in EU, until fixed is safer to not use
    delete requestBody["persona_id"];

    setTimeout(() => GraphApi.callSendApi(requestBody), delay);
  }

  sendRecurringMessage(notificationMessageToken, delay) {
    console.log("Received Recurring Message token");
    let requestBody = {},
      response;
    // Check if there is delay in the response
    if (response === undefined) {
      return;
    }
    requestBody = {
      recipient: {
        notification_messages_token: notificationMessageToken
      },
      message: response
    };

    setTimeout(() => GraphApi.callSendApi(requestBody), delay);
  }
  firstEntity(nlp, name) {
    return nlp && nlp.entities && nlp.entities[name] && nlp.entities[name][0];
  }

  handleReportLeadSubmittedEvent() {
    let requestBody = {
      custom_events: [
        {
          _eventName: "lead_submitted"
        }
      ],
      advertiser_tracking_enabled: 1,
      application_tracking_enabled: 1,
      page_id: config.pageId,
      page_scoped_user_id: this.user.psid,
      logging_source: "messenger_bot",
      logging_target: "page"
    };
    try {
      GraphApi.callAppEventApi(requestBody);
    } catch (error) {
      console.error("Error while reporting lead submitted", error);
    }
  }
};
