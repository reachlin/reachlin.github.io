$(document).ready(function(){
  impress().init();
  var slides = [];
  $("#impress div").children("h1").each(function(h1){
    var onepage = h1.nextUntil("h1");
    var div = $("#impress").add("div");
    div.add(h1);
    div.add(onepage);
  });
});