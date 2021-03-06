const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require("crypto");

const tmpPath = path.join(os.tmpdir(), "runway_ced_photoshop");
if (!fs.existsSync(tmpPath)){ fs.mkdirSync(tmpPath); }
console.log(`temporary image folder is at ${tmpPath}`);

const MIMETYPE='image/png' //'image/jpeg'
const IMGSIZE = 256;
const LAYERSETNAME = "generated";

/* Create an instance of CSInterface. */
var csInterface = new CSInterface();
/* Make a reference to your HTML button and add a click handler. */
var openButton = document.querySelector("#the-button");
openButton.addEventListener("click", onClick);

/* Write a helper function to pass instructions to the ExtendScript side. */
function onClick() {
  console.log("-----------------------------------------------");
  userMessage("Inference started.", "Preparing document.");
  prepareDocument(LAYERSETNAME)
    .then( async prepareDocumentResult => {
      if (!prepareDocumentResult['success']){
        userMessage("!!! error in preparing document", prepareDocumentResult['message'], "#f00");
        return false;
      }
      var layerSrcIds = prepareDocumentResult['layerSrcIds'];
      userMessage("Document preparation complete.", `... identified ${layerSrcIds.length} valid source layers.`);

      layerSrcIds.reduce( (prevPromise, id, n) => {
        return prevPromise.then(() => {
          return processLayerId(id,n,layerSrcIds.length);
        });
      }, Promise.resolve());


    });
};



function processLayerId(layerSrcId, idx, tot){
  console.log("------------------------");
  return new Promise(resolve => {

    const rando = crypto.randomBytes(4).toString("hex");
    const ext = (MIMETYPE === 'image/png' ? '.png' : '.jpg');
    const tmpPathSrc = path.join(tmpPath,'rw_'+rando+'_src'+ext).replace(/\\/g, "\\\\");
    const tmpPathDst = path.join(tmpPath,'rw_'+rando+'_dst'+ext).replace(/\\/g, "\\\\");
    //console.log(`saving to ${tmpPathSrc}`);

    var data = {};
    preInference(layerSrcId, tmpPathSrc, MIMETYPE, IMGSIZE)
      .then( async rslt => {
        [data.img64Src, data.bounds] = rslt;
        //data.bounds = Array(0,0,256,256);
        userMessage(`Step 1 of 3 complete for layer ${idx+1} of ${tot}.`, `... completed pre-inference, sent image to Runway`, '#666');

        //console.log("img64Src: "+img64Src);
        doInference(data.img64Src)
          .then( async img64Dst => {
            userMessage(`Step 2 of 3 complete for layer ${idx+1} of ${tot}.`, `... received inference image from Runway`, '#666');
            postInference(layerSrcId, img64Dst, tmpPathDst, data.bounds)
              .then( async rslt => {
                console.log("... post-inference complete.");
                userMessage(`Step 3 of 3 complete for layer ${idx+1} of ${tot}.`, `... post-inference completed.`);
                resolve();
              });
          });
      });

  });

}


async function prepareDocument() {
  var prepareDocumentResult = await evalScriptPromise("PSprepareDocument()"); // returns a json
  console.log(`prepareDocumentResult: ${prepareDocumentResult}`);
  prepareDocumentResult = JSON.parse(prepareDocumentResult);
  return(prepareDocumentResult);
};

async function preInference(layerSrcId, savePath, mimeType, imgSize){
  //console.log("preInference");
  const data = await evalScriptPromise(`JSXPreInference(${layerSrcId}, "${mimeType}", ${imgSize}, "${savePath}")`, true)
    .then( saveLayerResult => {
      saveLayerResult = JSON.parse(saveLayerResult);
      //console.log(saveLayerResult.img64);
      console.log(`layer ${layerSrcId} bounded to rectangle ${saveLayerResult.bounds} \t was converted to base64`);
      const bndsSve = saveLayerResult.bounds;

      var img = new Image;
      //img.onload = resizeImage;
      img.src = saveLayerResult.img64;
      return new Promise(resolve => {
        img.onload = () => {
          [img64, vec, size] = modifyHTMLImgAndConvertToBase64(img);
          var bndsGbl = Array( bndsSve[0]-vec[0], bndsSve[1]-vec[1],  bndsSve[0]-vec[0]+size, bndsSve[1]-vec[1]+size);
          console.log(`bndsGbl is ${bndsGbl}`);
          resolve([img64,bndsGbl]); // constructs data array
        };
      });

    });
  //console.log(data); // base64 image and a bounds array
  return data;
};

function modifyHTMLImgAndConvertToBase64(img) {
    console.log(`given image is ${img.naturalWidth} x  ${img.naturalHeight}`);

    // create an off-screen canvas and set to target size
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 256;

    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var dim = (w > h ? w : h);
    var drawCrds = Array(128-w/2, 128-h/2, w, h);

    if (dim>256){
      canvas.width = dim;
      canvas.height = dim;
      var drawCrds = Array(dim/2-w/2, dim/2-h/2, w, h);
    }
    console.log(`drawing to a ${canvas.width} image at coords ${drawCrds}`);

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, drawCrds[0], drawCrds[1], drawCrds[2], drawCrds[3]);
    img64 = canvas.toDataURL('image/jpeg', 1.0);
    var vec = Array(drawCrds[0], drawCrds[1]);
    var size = canvas.width;
    //bndsLcl = Array(drawCrds[0], drawCrds[1], drawCrds[0]+drawCrds[2], drawCrds[1]+drawCrds[3]);
    // encode image to data-uri with base64 version of compressed image
    return [img64, vec, size]; // drawImage takes (x,y,w,h), while photoshop takes (x1,y1,x2,y2))
}


async function doInference(img64In){
  const inputs = { "image_in": img64In };

  const img64Out = await fetch('http://localhost:8000/query', {
    method: 'POST',
    headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    },
    body: JSON.stringify(inputs)
  })
    .then(response => response.json())
    .then(outputs => {
      const { image_out } = outputs;
      return image_out;
      // use the outputs in your project
    })

  return img64Out;
}

async function postInference(layerSrcId, img64, filename, bounds){
  console.log("postInference");
  window.cep.fs.writeFile(
    filename,
    img64.replace(/^data:image\/[a-z]+;base64,/, ""),
    window.cep.encoding.Base64
  );
  const layerName = "out";
  bounds = JSON.stringify(bounds);
  console.log(`placing to bounds ${bounds}`);
  const rslt = await evalScriptPromise(`JSXPostInference(${layerSrcId}, ${bounds}, "${LAYERSETNAME}", "${filename}")`, true)
    .then( dlet => { window.cep.fs.deleteFile(filename) } );
    // deletes temporary file
};






// CONVERT IMG TO BASE64 ENCODING

async function imgToBase64(img, mimeType){
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  c.width = img.width;
  c.height = img.height;
  ctx.drawImage(img, 0, 0);
  return c.toDataURL(mimeType);
};

function evalScriptPromise(func, verbose=false) {
  if (verbose) console.log(`[MACRO] \t ${func}`);
  return new Promise((resolve, reject) => {
    csInterface.evalScript(func, (response) => {
      if (response === 'EvalScript error.'){
        console.log(`Error in calling "${func}". Response was "${response}"`);
        reject();
      }
      resolve(response);
    });
  });
};


function userMessage(str0, str1="", bkcolor="#333") {
  console.log(str0 +"\t|\t"+ str1);
  document.querySelector("#message-00").textContent = str0;
  document.querySelector("#message-01").textContent = str1;
  document.body.style.background = bkcolor;
};
