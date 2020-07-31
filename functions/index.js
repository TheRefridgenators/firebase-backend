import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {
  CloudTasksClient
} from "@google-cloud/tasks";
import {
  Expo,
  ExpoPushMessage
} from "expo-server-sdk";

// import { DetectedItem, ItemLabel, TaskPayload } from "./types";

// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

admin.initializeApp();
const expoInstance = new Expo();
const tasksClient = new CloudTasksClient();

/*
// Old notifyOnItemRemoved
export const notifyOnItemRemoved = functions.firestore
  .document("users/{userId}")
  .onUpdate((change, context) => {
    const previousItems: { label: string }[] = change.before.data().items;
    const previousItemLabels = previousItems.map((item) => item.label);

    const currentItems: { label: string }[] = change.after.data().items;
    const currentItemLabels = currentItems.map((item) => item.label);

    if (!arraysHaveSameValues(previousItemLabels, currentItemLabels)) return;

    const userPushTokens: string[] = change.after.data().pushTokens;

    const userNotifications: ExpoPushMessage[] = [];

    previousItemLabels.forEach((itemName) => {
      if (!currentItemLabels.includes(itemName)) {
        const itemNotification: ExpoPushMessage = {
          to: userPushTokens,
          sound: "default",
          badge: 1,
          title: "Item left out",
          body: `You left ${useProperArticle(
            itemName
          )} outside of the fridge for 20 minutes!`,
        };

        userNotifications.push(itemNotification);
      }
    });

    const notificationChunks = expoInstance.chunkPushNotifications(
      userNotifications
    );

    setTimeout(async () => {
      for (const chunk of notificationChunks) {
        try {
          await expoInstance.sendPushNotificationsAsync(chunk);
        } catch (error) {
          functions.logger.error("Error sending notifications: ", error);
        }
      }
    }, /* 20 * 60 *  1000; /* 20 minutes );
  });
  */

const projectId = "foodtrack-4a83e";
const location = "us-central1";
const taskQueue = "foodtrack-notifications";
const queuePath = tasksClient.queuePath(projectId, location, taskQueue);

const sendUserNotificationsUrl = `https://${location}-${projectId}.cloudfunctions.net/sendUserNotifications`;

export const onItemUpdate = functions.firestore
  .document("users/{userId}")
  .onUpdate(async (change, context) => {
    const userPushTokens = change.after.data().pushTokens ?? [];

    if (userPushTokens.length === 0) return;

    const previousItems = change.before.data().items;
    const previousLabels = previousItems.map((item) => item.label);

    const currentItems = change.after.data().items;
    const currentLabels = currentItems.map((item) => item.label);

    if (arraysHaveSameValues(previousLabels, currentLabels)) return;

    const missingItems = [];
    const sendTimeSeconds = Date.now() / 1000 + 10; /* 20 minutes from now */

    previousLabels.forEach((label) => {
      if (!currentLabels.includes(label)) {
        missingItems.push(label);
      }
    });

    const payload = {
      items: missingItems,
      pushTokens: userPushTokens,
    };

    // Required for type reasons; otherwise createTask errors out
    const httpMethod = "POST";

    const task = {
      httpRequest: {
        httpMethod,
        url: sendUserNotificationsUrl,
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        headers: {
          "Content-Type": "application/json",
        },
      },
      scheduleTime: {
        seconds: sendTimeSeconds,
      },
    };

    const [response] = await tasksClient.createTask({
      parent: queuePath,
      task,
    });

    const notificationDoc = await admin
      .firestore()
      .collection(`users/${context.params.userId}/notifications`)
      .doc();

    await notificationDoc.set({
      missingItems,
      taskName: response.name,
    });
  });

export const sendUserNotifications = functions.https.onRequest(
  async (req, res) => {
    const {
      items,
      pushTokens
    } = req.body;

    const itemNotifications = items.map((item) =>
      itemToPushMessage(item, pushTokens)
    );

    const notificationChunks = expoInstance.chunkPushNotifications(
      itemNotifications
    );

    for (const chunk of notificationChunks) {
      try {
        await expoInstance.sendPushNotificationsAsync(chunk);
        console.log("Sent a notification")
      } catch (error) {
        console.error(error);
      }
    }

    res.send(200);
  }
);

function itemToPushMessage(
  label, pushTokens
) {
  return {
    to: pushTokens,
    sound: "default",
    badge: 1,
    title: "Item left out",
    body: `You left ${useProperArticle(
      label
    )} outside of the fridge for 20 minutes!`,
  };
}

function arraysHaveSameValues(array1, array2) {
  if (array1.length !== array2.length) return false;

  let areEqual = true;

  array1.forEach((element) => {
    if (!array2.includes(element)) {
      areEqual = false;
    }
  });

  array2.forEach((element) => {
    if (!array1.includes(element)) {
      areEqual = false;
    }
  });

  return areEqual;
}

function useProperArticle(noun) {
  return (noun.search(/^aeiou/i) ? "an " : "a ") + noun;
}

//export const addUserSnapshot = functions.storage.object().onFinalize()